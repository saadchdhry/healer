import { createHash } from 'node:crypto';
import { Environment, runAgent, trainRouter, type AgentVersion, type Job, type Proposal, type RouterExample, type RouterModel, type Tier, type Trace } from '@healer/agent';
import { newId, type Healer } from './console.ts';
import { pool } from './evalRunner.ts';
import { judgeTrace } from './judge.ts';
import { createProposal } from './propose.ts';

// The real model surface: a small router trained on the demo's own traces, deciding per request whether
// the small model is enough. Supervised learning at toy scale.

export const EASY_TIER: Tier = 'haiku';
const CONCURRENCY = 4;
// A replay whose run crashed (an API error, not a wrong answer) is retried, so plumbing never becomes a label.
const RUN_ATTEMPTS = 3;

export function hardTierFor(live: AgentVersion): Tier {
  const current = live.model.mode === 'fixed' ? live.model.tier : live.model.hardTier;
  return current === EASY_TIER ? 'sonnet' : current;
}

// Distinct first customer messages from real traffic, newest first.
function sourceTraces(h: Healer, max: number): Trace[] {
  const seen = new Set<string>();
  const out: Trace[] = [];
  for (const s of h.store.traceSummaries()) {
    if (out.length >= max) break;
    if (!['shop', 'simulator', 'seed'].includes(s.source) || seen.has(s.input)) continue;
    const trace = h.store.trace(s.id)!;
    if (trace.history.length || trace.error) continue;
    seen.add(trace.input);
    out.push(trace);
  }
  return out;
}

async function replay(h: Healer, live: AgentVersion, source: Trace, tier: Tier): Promise<{ trace: Trace; passed: boolean }> {
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
  const { verdict } = await judgeTrace(h, trace, { sandbox: true });
  return { trace, passed: verdict.passed };
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
    job.progress(0, sources.length);
    await pool(sources, CONCURRENCY, async (source) => {
      h.checkEpoch(epoch);
      const easy = await replay(h, live, source, EASY_TIER);
      const strong = await replay(h, live, source, hard);
      h.checkEpoch(epoch);
      examples.push({
        id: `rx_${textKey(source.input).slice(0, 12)}`,
        text: source.input,
        needsStrong: !easy.passed && strong.passed,
        easyTraceId: easy.trace.id,
        hardTraceId: strong.trace.id,
        easyPassed: easy.passed,
        hardPassed: strong.passed,
      });
      job.progress(++done);
    });
    const order = new Map(sources.map((s, i) => [s.input, i]));
    const dataset = assignSplits(examples.sort((a, b) => order.get(a.text)! - order.get(b.text)!));
    h.store.setRouterDataset(dataset);
    const positives = dataset.filter((e) => e.needsStrong).length;
    h.activity(
      'judge',
      `Router dataset: ${dataset.length} requests replayed on ${EASY_TIER} and ${hard}; ${positives} needed ${hard} (failed on ${EASY_TIER}, passed on ${hard})`,
    );
    h.changed('trace', 'verdict');
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
    rationale: `Router ${router.id} is a bag-of-words classifier trained on ${m.trainSize} requests from this demo's own traces, each replayed on ${EASY_TIER} and ${hard}. It sends a request to ${hard} only when it predicts ${EASY_TIER} would fail. It scores ${pct(m.trainAccuracy)} on its training examples and ${pct(m.valAccuracy)} on ${m.valSize} held-out examples. This is supervised learning at toy scale, so the gate decides: it is kept only if the pass rate holds, and the point is a lower cost per task.`,
    changes: [{ surface: 'model', op: 'set_model', model: { mode: 'routed', easyTier: EASY_TIER, hardTier: hard, effort: live.model.effort, router } }],
    proposeRun: null,
  });
}
