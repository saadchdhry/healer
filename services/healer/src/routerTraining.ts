import { createHash } from 'node:crypto';
import { Environment, isHighStakesTool, roundCents, runAgent, trainRouter, type AgentVersion, type Job, type Proposal, type RouterExample, type RouterModel, type Tier, type Trace } from '@healer/agent';
import { newId, type Healer } from './console.ts';
import { pool } from './evalRunner.ts';
import { policyChecks } from './judge.ts';
import { centsApart, envChanges, usd } from './policy.ts';
import { createProposal } from './propose.ts';

// The real model surface: a small router trained on the demo's own traces. It learns which requests carry risk and
// sends those to the stronger model. Supervised learning at toy scale.

export const EASY_TIER: Tier = 'haiku';
export const EASY_REPLAYS = 4;
const CONCURRENCY = 3;
// A replay whose run crashed (an API error, not a wrong answer) is retried, so plumbing never becomes a label.
const RUN_ATTEMPTS = 3;

export function hardTierFor(live: AgentVersion): Tier {
  const current = live.model.mode === 'fixed' ? live.model.tier : live.model.hardTier;
  return current === EASY_TIER ? 'sonnet' : current;
}

// Distinct first customer messages from real traffic. Seeded cases come first, so a size cut never drops the
// known-tricky requests; then the newest of the rest.
export function sourceTraces(h: Healer, max: number): Trace[] {
  const seen = new Set<string>();
  const firsts: Trace[] = [];
  for (const s of h.store.traceSummaries()) {
    if (!['shop', 'simulator', 'seed'].includes(s.source) || seen.has(s.input)) continue;
    const trace = h.store.trace(s.id)!;
    if (trace.history.length || trace.error) continue;
    seen.add(trace.input);
    firsts.push(trace);
  }
  return [...firsts.filter((t) => t.source === 'seed'), ...firsts.filter((t) => t.source !== 'seed')].slice(0, max);
}

async function replay(h: Healer, live: AgentVersion, source: Trace, tier: Tier): Promise<Trace> {
  const version: AgentVersion = { ...live, model: { mode: 'fixed', tier, effort: live.model.effort } };
  let trace: Trace;
  let attempt = 0;
  do {
    trace = await runAgent({
      version,
      env: new Environment(source.envBefore),
      customerId: source.customerId,
      history: [],
      message: source.input,
      threadId: newId('th_replay'),
      traceId: newId('tr_replay'),
      source: 'replay',
      llm: h.llm(),
    });
    h.recordTraceCost(trace.runs);
    attempt++;
  } while (trace.error && attempt < RUN_ATTEMPTS);
  h.store.saveTrace(trace);
  return trace;
}

type Write = { amount: number; method: string };

// What a run did to the records, keyed by the kind of write and the order it touched.
function writes(t: Trace): Map<string, Write> {
  const c = envChanges(t.envBefore, t.envAfter);
  const out = new Map<string, Write>();
  for (const r of c.newRefunds) {
    const key = `refund on ${r.orderId}`;
    const prev = out.get(key);
    out.set(key, { amount: roundCents((prev?.amount ?? 0) + r.amount), method: prev && prev.method !== r.method ? 'mixed methods' : r.method });
  }
  for (const p of c.cancelled) out.set(`cancellation of ${p.after.id}`, { amount: 0, method: '' });
  for (const p of c.readdressed) out.set(`address change on ${p.after.id}`, { amount: 0, method: '' });
  for (const e of c.newEscalations) out.set(`escalation about ${e.orderId ?? 'the conversation'}`, { amount: 0, method: '' });
  return out;
}

export const passesPolicy = (t: Trace) => !t.error && policyChecks(t).every((c) => c.passed);

// Why an easy replay is wrong, or null. No model judge: a policy rule broken in code, or a write that contradicts
// the strong tier's replay when that replay kept every rule. Asking a question where the strong tier acted is not wrong.
export function wrongness(easy: Trace, reference: Trace): string | null {
  if (easy.error) return null;
  const broken = policyChecks(easy).filter((c) => !c.passed);
  if (broken.length) return `broke a policy rule (${broken.map((c) => c.label).join('; ')})`;
  if (!passesPolicy(reference)) return null;
  const ref = writes(reference);
  for (const [key, w] of writes(easy)) {
    const r = ref.get(key);
    if (!r) return `made a ${key} that the reference did not make`;
    if (key.startsWith('refund') && (centsApart(w.amount, r.amount) > 1 || w.method !== r.method)) {
      return `refunded ${usd(w.amount)} to ${w.method} where the reference refunded ${usd(r.amount)} to ${r.method}`;
    }
  }
  return null;
}

export const attemptedHighStakes = (t: Trace) => t.toolCalls.some((c) => isHighStakesTool(c.name));

// Failures are too rare to learn from alone, so a request also needs the strong model when any replay attempted a
// tool that moves money or cannot be undone, even one a guard blocked. Only a measured failure needs a reference
// that kept every rule. `shown` is the easy replay the dataset links to: the wrong one, else one that took the risk.
export function labelRequest(reference: Trace, easy: Trace[]): { reason: RouterExample['reason']; easyPassed: boolean; hardPassed: boolean; shown: Trace } {
  const wrong = easy.find((t) => wrongness(t, reference) !== null);
  const hardPassed = passesPolicy(reference);
  const reason = wrong && hardPassed ? 'measured_failure' : [reference, ...easy].some(attemptedHighStakes) ? 'high_stakes' : null;
  return { reason, easyPassed: !wrong, hardPassed, shown: wrong ?? easy.find(attemptedHighStakes) ?? easy[0]! };
}

const textKey = (text: string) => createHash('sha256').update(text).digest('hex');

// Deterministic and stratified: within each class, ordered by a hash of the text, every fourth example is held out.
// With fewer than four positives, every positive stays in training and validation sees only negatives.
export function assignSplits(examples: Omit<RouterExample, 'split'>[]): RouterExample[] {
  const split = new Map<string, RouterExample['split']>();
  for (const positive of [true, false]) {
    examples
      .filter((e) => e.needsStrong === positive)
      .sort((a, b) => (textKey(a.text) < textKey(b.text) ? -1 : 1))
      .forEach((e, i) => split.set(e.id, i % 4 === 3 ? 'val' : 'train'));
  }
  return examples.map((e) => ({ ...e, split: split.get(e.id)! }));
}

export function startDatasetJob(h: Healer, maxExamples: number): Job {
  return h.startJob('router_dataset', `Build a router dataset of up to ${maxExamples} examples`, null, async (job) => {
    const epoch = h.epoch;
    const live = h.store.liveVersion()!;
    const hard = hardTierFor(live);
    const sources = sourceTraces(h, maxExamples);
    const examples: Omit<RouterExample, 'split'>[] = [];
    let done = 0;
    let replays = 0;
    job.progress(0, sources.length);
    await pool(sources, CONCURRENCY, async (source) => {
      h.checkEpoch(epoch);
      const [reference, ...easy] = await Promise.all([replay(h, live, source, hard), ...Array.from({ length: EASY_REPLAYS }, () => replay(h, live, source, EASY_TIER))]);
      h.checkEpoch(epoch);
      replays += 1 + easy.length;
      const { reason, easyPassed, hardPassed, shown } = labelRequest(reference, easy);
      examples.push({
        id: `rx_${textKey(source.input).slice(0, 12)}`,
        text: source.input,
        needsStrong: reason !== null,
        reason,
        easyTraceId: shown.id,
        hardTraceId: reference.id,
        easyPassed,
        hardPassed,
      });
      job.progress(++done);
    });
    const order = new Map(sources.map((s, i) => [s.input, i]));
    const dataset = assignSplits(examples.sort((a, b) => order.get(a.text)! - order.get(b.text)!));
    h.store.setRouterDataset(dataset);
    const count = (reason: RouterExample['reason']) => dataset.filter((e) => e.reason === reason).length;
    h.activity(
      'judge',
      `Router dataset: ${dataset.length} requests, ${replays} replays (${EASY_REPLAYS} on ${EASY_TIER} and 1 on ${hard} each), labelled by risk in code, no model judge; ${dataset.length - count(null)} carry risk and go to ${hard} (${count('high_stakes')} attempted a refund or cancellation, ${count('measured_failure')} failed on ${EASY_TIER} where ${hard} kept every rule)`,
    );
    h.changed('trace');
  });
}

export async function trainAndStore(h: Healer): Promise<RouterModel> {
  return h.trackJob('router_train', 'Train the router', null, async (job) => {
    const router = trainRouter(h.store.routerDataset());
    h.store.setRouters([...h.store.routers().filter((r) => r.id !== router.id), router]);
    const m = router.metrics;
    h.activity(
      'propose',
      `Trained router ${router.id}: ${Math.round(m.trainAccuracy * 100)}% on ${m.trainSize} training examples, ${Math.round(m.valAccuracy * 100)}% on ${m.valSize} held out`,
    );
    job.progress(1, 1);
    h.scheduleOverview();
    return router;
  });
}

export function proposeRouter(h: Healer, router: RouterModel): Proposal {
  const live = h.store.liveVersion()!;
  const hard = hardTierFor(live);
  const m = router.metrics;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return createProposal(h, {
    author: 'loop',
    issueId: null,
    title: `Route each request between ${EASY_TIER} and ${hard} with router ${router.id}`,
    rationale: [
      `Router ${router.id} is a bag-of-words classifier trained on ${m.trainSize} requests from this demo's own traces, each replayed ${EASY_REPLAYS} times on ${EASY_TIER} and once on ${hard}. It learns which requests carry risk and sends those to ${hard}, while lookups and questions stay on ${EASY_TIER}.`,
      `A request counts as risky when a replay attempted a refund or a cancellation, or when ${EASY_TIER} got it wrong where ${hard} kept every rule; ${m.trainPositives} of the training requests do.`,
      `It scores ${pct(m.trainAccuracy)} on its training examples and ${pct(m.valAccuracy)} on ${m.valSize} held-out examples.`,
      m.valPositives
        ? `Of the ${m.valPositives} held-out requests that carry risk, it routes ${pct(m.valRecall ?? 0)} to ${hard}.`
        : `None of the held-out requests carry risk, so the held-out accuracy says nothing about whether it sends risky requests to ${hard}; it only shows that low-risk requests stay on ${EASY_TIER}.`,
      'This is supervised learning at toy scale, so the gate decides: it is kept only if every capability case is routed to the strong tier, nothing regresses and the pass rate holds. The point is a lower cost per task.',
    ].join(' '),
    changes: [{ surface: 'model', op: 'set_model', model: { mode: 'routed', easyTier: EASY_TIER, hardTier: hard, effort: live.model.effort, router } }],
    proposeRun: null,
  });
}
