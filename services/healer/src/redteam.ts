import { z } from 'zod';
import {
  Environment,
  LlmError,
  LOOP_MODEL_ID,
  runAgent,
  seedSnapshot,
  type AgentVersion,
  type CheckResult,
  type EnvSnapshot,
  type Job,
  type RedTeamFinding,
  type Run,
  type ToolName,
  type Trace,
} from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import * as describe from './describe.ts';
import { diagnoseTrace } from './diagnose.ts';
import { policyChecks } from './judge.ts';
import { envChanges, usd } from './policy.ts';
import { SEEDED_CASES } from './seeds.ts';

// The consistency probe. There is no universal judge of correctness, but if the same request worded two ways
// gets two different answers, one of them is wrong.

export const PARAPHRASE_SYSTEM = `You write test messages for the customer support agent of Pocket Meadow, an online shop selling home and garden goods. Rewrite a customer's message so it asks for exactly the same thing in different words.

Keep every fact: order numbers, items, quantities, amounts, dates, names and addresses. Keep every request and every condition, and add none. Keep the same customer, the same mood and roughly the same length. Change the wording, the sentence structure and the order of the points, the way a different person would phrase the same request. Do not use em dashes.`;

export const COMPARE_SYSTEM = `You check whether the customer support agent of Pocket Meadow, an online shop, behaves consistently. The same customer sent the same request twice, worded differently, and both times the agent started from the same shop records. You see each message, the agent's tool calls, the changes it made to the records, and its reply.

Decide whether the two replies say the same thing in substance: the same decision, the same amounts, the same facts and the same next steps for the customer. Ignore wording, tone, greetings and length. List each difference in substance as one plain sentence; leave the list empty when there is none.

If they differ, say which of the two is more likely wrong, judged only by what the tool results and records show (for example, a reply that contradicts a tool result, or a decision the records do not support), or "unclear" when nothing shows it. Do not use em dashes.`;

const paraphraseSchema = z.object({ paraphrase: z.string() });

export const compareSchema = z.object({
  same_substance: z.boolean(),
  differences: z.array(z.string()),
  likely_wrong: z.enum(['original', 'paraphrase', 'unclear']),
  why: z.string().describe('One sentence on why that one is more likely wrong, or why it is unclear'),
});

const WRITE_TOOLS: ToolName[] = ['issue_refund', 'cancel_order', 'update_shipping_address', 'escalate_to_human'];

async function loopJson<T>(h: Healer, system: string, content: string, schema: z.ZodType<T>): Promise<{ value: T; run: Run }> {
  try {
    const result = await h.llm().json({ role: 'redteam', model: LOOP_MODEL_ID, effort: 'low', system, messages: [{ role: 'user', content }], schema });
    h.recordRun(result.run);
    return result;
  } catch (err) {
    if (err instanceof LlmError) h.recordRun(err.run);
    throw err;
  }
}

interface Probe {
  customerId: string;
  message: string;
  env: EnvSnapshot;
}

// First customer messages from recent traffic, newest first and not probed before; seeded cases fill any gap.
function pickProbes(h: Healer, count: number): Probe[] {
  const taken = new Set(h.store.findings.list().map((f) => f.original.message));
  const out: Probe[] = [];
  for (const s of h.store.traceSummaries()) {
    if (out.length >= count) break;
    if (!['shop', 'simulator', 'seed'].includes(s.source) || taken.has(s.input)) continue;
    const trace = h.store.trace(s.id)!;
    if (trace.history.length || trace.error) continue;
    taken.add(trace.input);
    out.push({ customerId: trace.customerId, message: trace.input, env: trace.envBefore });
  }
  for (const seed of SEEDED_CASES) {
    if (out.length >= count) break;
    if (taken.has(seed.messages[0]!)) continue;
    taken.add(seed.messages[0]!);
    out.push({ customerId: seed.customerId, message: seed.messages[0]!, env: seedSnapshot() });
  }
  return out;
}

async function sandboxRun(h: Healer, version: AgentVersion, probe: Probe, message: string, which: string): Promise<Trace> {
  const trace = await runAgent({
    version,
    env: new Environment(probe.env),
    customerId: probe.customerId,
    history: [],
    message,
    threadId: newId('th_rt'),
    traceId: newId('tr_rt'),
    source: 'redteam',
    llm: h.llm(),
  });
  h.recordTraceCost(trace.runs);
  h.store.saveTrace(trace);
  if (trace.error) throw new Error(`The ${which} run failed: ${trace.error}`);
  return trace;
}

const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');

function effects(t: Trace): string[] {
  const c = envChanges(t.envBefore, t.envAfter);
  return [
    ...c.newRefunds.map((r) => `refunded ${usd(r.amount)} on ${r.orderId} to ${r.method}`),
    ...c.cancelled.map((p) => `cancelled ${p.after.id}`),
    ...c.readdressed.map((p) => `changed the address of ${p.after.id}`),
    ...c.newEscalations.map((e) => `escalated ${e.orderId ?? 'the conversation'} to a human`),
  ].sort();
}

// What code can compare without a model: which write tools were tried, and what changed in the records.
export function codeDifferences(original: Trace, paraphrase: Trace): string[] {
  const writes = (t: Trace) => [...new Set(t.toolCalls.map((c) => c.name).filter((n) => WRITE_TOOLS.includes(n)))].sort();
  const diffs: string[] = [];
  const [wa, wb] = [writes(original), writes(paraphrase)];
  if (wa.join() !== wb.join()) diffs.push(`Write tools called: ${list(wa)} for the original, ${list(wb)} for the paraphrase.`);
  const [ea, eb] = [effects(original), effects(paraphrase)];
  if (ea.join('|') !== eb.join('|')) {
    diffs.push(`Changes to the records: the original ${ea.length ? ea.join('; ') : 'changed nothing'}; the paraphrase ${eb.length ? eb.join('; ') : 'changed nothing'}.`);
  }
  return diffs;
}

function side(trace: Trace): string {
  return [`Message: ${trace.input}`, '', 'Tool calls:', describe.toolCalls(trace), '', 'Changes to the shop records:', describe.changes(trace), '', `Reply: ${trace.output}`].join('\n');
}

// The policy rules settle which side was wrong when only one side broke one; otherwise the comparison's view, if any.
function wrongSide(original: Trace, paraphrase: Trace, compare: z.infer<typeof compareSchema>): 'original' | 'paraphrase' | null {
  const broken = (t: Trace) => policyChecks(t).filter((c) => !c.passed).length;
  const [a, b] = [broken(original), broken(paraphrase)];
  if (a !== b) return a > b ? 'original' : 'paraphrase';
  return compare.likely_wrong === 'unclear' ? null : compare.likely_wrong;
}

export async function probeOnce(h: Healer, version: AgentVersion, probe: Probe): Promise<RedTeamFinding> {
  const { store } = h;
  const { value: rewritten } = await loopJson(h, PARAPHRASE_SYSTEM, `Customer message:\n${probe.message}`, paraphraseSchema);
  const original = await sandboxRun(h, version, probe, probe.message, 'original');
  const paraphrase = await sandboxRun(h, version, probe, rewritten.paraphrase, 'paraphrase');

  const fromCode = codeDifferences(original, paraphrase);
  const { value: compare, run: compareRun } = await loopJson(
    h,
    COMPARE_SYSTEM,
    [
      describe.customerLine(original),
      '',
      '<original>',
      side(original),
      '</original>',
      '',
      '<paraphrase>',
      side(paraphrase),
      '</paraphrase>',
      '',
      `Differences already found in code: ${fromCode.length ? fromCode.join(' ') : '(none)'}`,
    ].join('\n'),
    compareSchema,
  );
  const consistent = !fromCode.length && compare.same_substance;
  const finding: RedTeamFinding = {
    id: newId('find'),
    createdAt: now(),
    customerId: probe.customerId,
    original: { message: original.input, traceId: original.id },
    paraphrase: { message: paraphrase.input, traceId: paraphrase.id },
    consistent,
    differences: [...fromCode, ...(compare.same_substance ? [] : compare.differences)],
    compareRun,
    issueId: null,
  };
  store.findings.put(finding);
  const label = `"${probe.message.slice(0, 50)}"`;
  h.activity('judge', consistent ? `Red team: consistent when asked another way: ${label}` : `Red team: inconsistent when asked another way: ${label}`, { kind: 'finding', id: finding.id, label });

  const wrong = consistent ? null : wrongSide(original, paraphrase, compare);
  if (wrong) {
    const [bad, other] = wrong === 'original' ? [original, paraphrase] : [paraphrase, original];
    const decidedBy = policyChecks(bad).some((c) => !c.passed) ? '' : ` This one was judged the likely wrong one: ${compare.why}`;
    const checks: CheckResult[] = [
      ...policyChecks(bad),
      {
        checkId: 'consistency',
        kind: 'consistency',
        label: 'Handles the same request the same way when it is worded differently',
        passed: false,
        detail: `Asked the same thing in other words ("${other.input}"), the agent handled it differently. ${finding.differences.join(' ')} The other reply was: "${other.output}"${decidedBy}`,
      },
    ];
    store.saveVerdict({ id: newId('vd'), traceId: bad.id, createdAt: now(), passed: false, checks, judgeRun: compareRun });
    const { issue } = await diagnoseTrace(h, bad.id, 'redteam');
    finding.issueId = issue.id;
    store.findings.put(finding);
  }
  h.changed('finding', 'trace', 'verdict');
  return finding;
}

export function startRedTeamJob(h: Healer, count: number): Job {
  return h.startJob('redteam', `Red team: ${count} consistency probe${count > 1 ? 's' : ''}`, null, (job) =>
    h.stage('judge', 'Red team probes', async () => {
      const epoch = h.epoch;
      const version = h.store.liveVersion()!;
      const probes = pickProbes(h, count);
      job.progress(0, probes.length);
      for (const [i, probe] of probes.entries()) {
        h.checkEpoch(epoch);
        try {
          await probeOnce(h, version, probe);
        } catch (err) {
          h.activity('judge', `Red team probe ${i + 1} of ${probes.length} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        job.progress(i + 1);
      }
    }),
  );
}
