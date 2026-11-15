import { z } from 'zod';
import { LlmError, LOOP_MODEL_ID, type AgentVersion, type Cause, type GateRun, type EvalCase, type EvalCheckSpec, type Issue, type Job, type Surface, type Verdict } from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import * as describe from './describe.ts';
import { CHECK_PARAMS } from './evals.ts';
import { validateCase } from './validate.ts';

export const SURFACE_FOR_CAUSE: Record<Cause, Surface> = { knowledge: 'context', process: 'harness', capability: 'model' };

const CAUSES = `Causes. Pick exactly one:
- knowledge: the agent lacked a fact about the shop's rules or about this customer. Nothing in its context notes or system prompt states the rule it broke. Fixed in the context: a shop-scope note for a shop rule, a customer-scope note for something true of this customer only.
- process: the agent had what it needed but worked in the wrong order, skipped a check (for example acting on an order without looking it up first), or needs a rule enforced in code. Fixed in the harness: the system prompt, a tool description, or a guard.
- capability: the context already states the needed rule and the harness the needed procedure, and the agent still got the reasoning or arithmetic wrong. Fixed by a stronger model. Choose it only when you can copy, word for word, the note or instruction in the live version that already states the rule the failed check names, and give those words as covering_quote. If no note or instruction states that rule, the cause is knowledge, however hard the request looks.
Check the live version before choosing: if its notes already state the broken rule, the cause is not knowledge.

Scope is "customer" only when the lesson concerns this one customer. Every shop rule has scope "shop".`;

export const DIAGNOSE_SYSTEM = `You diagnose failures of the customer support agent of Pocket Meadow, an online shop selling home and garden goods. You get one failed conversation with the checks it failed, the agent version now live, and the issues already open. Decide why the agent failed, file the failure under an issue, and write a test that catches this failure if it ever happens again.

The failed checks are your evidence. A policy check's detail states the shop rule that was broken, with the real numbers; treat it as true. The owed-refund check's detail states what the customer was due under shop policy, worked out in code from the items the judge read in their request; treat the amount as true and use it as the exact refund amount of an end_state check, or require an escalation when the detail says the refund must go to a human.

${CAUSES}

Attach the failure to an open issue when it is the same underlying problem with the same fix: the same broken rule, cause and scope. Otherwise open a new issue. Give a new issue a short, specific title naming the rule or behaviour (for example "Refunds issued after the 30-day window"), and a summary of the class of failure in two or three sentences, including the rule as the evidence states it.

Then write the eval case. It replays the customer's latest message against the same starting records and conversation, and a check over every policy rule is added for you. Add the checks that describe correct behaviour for this situation:
- end_state: what the shop records must look like afterwards for one order. Its refund field covers only refunds the agent issues during this conversation; refunds already on the order beforehand are ignored. So use {"none": true} when the agent must not refund, or the exact amount and method it must refund. Also the order status, text the shipping address must contain, and whether the agent escalated to a human.
- tool_sequence: tools that must or must not be called, or that must be called before another.
- rubric: something the reply must say or do, judged by a model. One sentence, specific and checkable.
- exact_match: text the reply must contain. Rarely the right choice.
Prefer end_state and tool_sequence. Each check must pass for any correct handling, not one particular wording, and must not demand behaviour the evidence does not establish. Give each check a short label.`;

const modelCheck = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('end_state'), label: z.string(), params: CHECK_PARAMS.end_state }),
  z.object({ kind: z.literal('tool_sequence'), label: z.string(), params: CHECK_PARAMS.tool_sequence }),
  z.object({ kind: z.literal('rubric'), label: z.string(), params: CHECK_PARAMS.rubric }),
  z.object({ kind: z.literal('exact_match'), label: z.string(), params: CHECK_PARAMS.exact_match }),
]);

const coveringQuote = z
  .string()
  .nullable()
  .describe("Only for cause capability: the exact words, copied from the live version's context notes, system prompt or tool descriptions, that already state the rule the failed check names. Null for any other cause.");

export const diagnoseSchema = z.object({
  reasoning: z.string().describe('Why the agent failed, and why this cause'),
  covering_quote: coveringQuote,
  attach_to: z.string().nullable().describe('The id of the open issue this failure belongs to, or null to open a new issue'),
  new_issue: z
    .object({ title: z.string(), summary: z.string(), cause: z.enum(['knowledge', 'process', 'capability']), scope: z.enum(['shop', 'customer']) })
    .nullable()
    .describe('Required when attach_to is null'),
  eval_case: z.object({ title: z.string(), checks: z.array(modelCheck) }),
});

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

// Whether `quote` really appears in the version's context or harness text. A capability diagnosis must point at the rule the
// agent already had; without it the gap is missing knowledge, and a stronger model would not fix it.
export function quoteInVersion(v: AgentVersion, quote: string | null): boolean {
  const q = squash((quote ?? '').replace(/^["'“”]+|["'“”]+$/g, ''));
  if (!q) return false;
  const text = squash([...v.context.map((n) => n.text), v.harness.systemPrompt, ...v.harness.tools.map((t) => t.description)].join('\n'));
  return text.includes(q);
}

// Falls back from capability to knowledge (a shop note) when the covering rule cannot be found in the live version.
function checkedCause(h: Healer, live: AgentVersion, cause: Cause, scope: 'shop' | 'customer', quote: string | null, title: string): { cause: Cause; scope: 'shop' | 'customer' } {
  if (cause !== 'capability' || quoteInVersion(live, quote)) return { cause, scope };
  h.activity(
    'diagnose',
    `Diagnosis called "${title}" a capability gap but ${quote ? 'its quote does not appear' : 'quoted no note or instruction'} in version ${live.id}, so it is filed as a knowledge gap for the whole shop`,
  );
  return { cause: 'knowledge', scope: 'shop' };
}

// Whether a trace's failure is already filed. A preference the judge filed from the same trace does not count:
// the failure still needs its own diagnosis and eval case.
export function failureFiled(h: Healer, traceId: string): boolean {
  return h.store.issues.list().some((i) => i.kind !== 'preference' && i.traceIds.includes(traceId));
}

// Failed verdicts whose failure is in no issue yet. Runs that crashed are plumbing, not agent behaviour, so they are left out.
export function undiagnosed(h: Healer): Verdict[] {
  const filed = new Set(h.store.issues.list().filter((i) => i.kind !== 'preference').flatMap((i) => i.traceIds));
  return h.store
    .verdicts({ passed: false })
    .reverse()
    .filter((v) => !filed.has(v.traceId) && !v.checks.some((c) => c.checkId === 'run_error'));
}

export async function diagnoseTrace(h: Healer, traceId: string, origin: EvalCase['origin'] = 'failure'): Promise<{ issue: Issue; evalCase: EvalCase; opened: boolean }> {
  const { store } = h;
  const trace = store.trace(traceId);
  const verdict = store.verdictForTrace(traceId);
  if (!trace || !verdict) throw new Error(`Trace ${traceId} has no verdict to diagnose`);
  const live = store.liveVersion()!;
  const open = store.issues.list().filter((i) => i.status === 'open' || i.status === 'proposed');
  const message = [
    '<failure>',
    describe.failure(trace, verdict.checks),
    '</failure>',
    '',
    '<live_version>',
    describe.version(live),
    '</live_version>',
    '',
    '<open_issues>',
    open.length ? open.map(describe.issue).join('\n') : '(none)',
    '</open_issues>',
  ].join('\n');

  let result;
  try {
    result = await h.llm().json({ role: 'diagnose', model: LOOP_MODEL_ID, effort: 'medium', system: DIAGNOSE_SYSTEM, messages: [{ role: 'user', content: message }], schema: diagnoseSchema });
  } catch (err) {
    if (err instanceof LlmError) h.recordRun(err.run);
    throw err;
  }
  h.recordRun(result.run);
  const out = result.value;

  let issue: Issue;
  const opened = out.attach_to === null;
  if (out.attach_to !== null) {
    const found = open.find((i) => i.id === out.attach_to);
    if (!found) throw new Error(`Diagnosis attached the failure to ${out.attach_to}, which is not an open issue`);
    issue = found;
  } else {
    if (!out.new_issue) throw new Error('Diagnosis opened no issue and attached to none');
    const { title, summary } = out.new_issue;
    const { cause, scope } = checkedCause(h, live, out.new_issue.cause, out.new_issue.scope, out.covering_quote, title);
    issue = {
      id: newId('iss'),
      kind: 'failure',
      createdAt: now(),
      updatedAt: now(),
      title,
      summary,
      cause,
      surface: SURFACE_FOR_CAUSE[cause],
      scope: scope === 'shop' ? { kind: 'shop' } : { kind: 'customer', customerId: trace.customerId },
      status: 'open',
      traceIds: [],
      evalCaseIds: [],
      proposalIds: [],
      diagnoseRun: result.run,
    };
  }

  const checks: EvalCheckSpec[] = [
    { id: 'policy', kind: 'invariant', label: 'Every shop policy rule holds', params: {} },
    ...out.eval_case.checks.map((c, i) => ({ id: `c${i + 1}`, kind: c.kind, label: c.label, params: c.params as Record<string, unknown> })),
  ];
  const evalCase: EvalCase = {
    id: newId('ev'),
    createdAt: now(),
    title: out.eval_case.title,
    origin,
    sourceTraceId: trace.id,
    issueId: issue.id,
    customerId: trace.customerId,
    history: trace.history,
    message: trace.input,
    env: trace.envBefore,
    checks,
    enabled: true,
    validation: null,
  };
  // Tested before it is stored, so the gate never trusts a case that demands what no correct agent can do.
  store.evalCases.put(await validateCase(h, evalCase, trace));
  issue.traceIds.push(trace.id);
  issue.evalCaseIds.push(evalCase.id);
  issue.updatedAt = now();
  store.issues.put(issue);

  const ref = { kind: 'issue' as const, id: issue.id, label: issue.title };
  h.activity('diagnose', opened ? `New ${issue.cause} issue: ${issue.title}` : `Another failure filed under: ${issue.title}`, ref);
  h.activity('diagnose', `New eval case: ${evalCase.title}`, { kind: 'evalCase', id: evalCase.id, label: evalCase.title });
  h.changed('issue', 'evalCase');
  return { issue, evalCase, opened };
}

export function startDiagnoseJob(h: Healer): Job {
  return h.startJob('diagnose', 'Diagnose failed verdicts', null, (job) =>
    h.stage('diagnose', 'Diagnose failed verdicts', async () => {
      const pending = undiagnosed(h);
      job.progress(0, pending.length);
      for (const [i, v] of pending.entries()) {
        await diagnoseTrace(h, v.traceId);
        job.progress(i + 1);
      }
    }),
  );
}

export const REDIAGNOSE_SYSTEM = `You diagnose failures of the customer support agent of Pocket Meadow, an online shop selling home and garden goods. An issue was diagnosed as a capability gap, so the loop proposed moving the agent to a stronger model. The eval gate rejected that change because the issue's own eval case still fails on the stronger model. That is evidence against a capability gap. You get the issue, its latest failed conversation with the checks it failed, the gate's reasons, and the agent version now live. Decide the cause again.

A policy check's detail states the shop rule that was broken, with the real numbers; treat it as true.

${CAUSES}`;

export const rediagnoseSchema = z.object({
  reasoning: z.string().describe('Why the agent failed, what the rejected stronger model shows, and why this cause'),
  cause: z.enum(['knowledge', 'process', 'capability']),
  scope: z.enum(['shop', 'customer']),
  covering_quote: coveringQuote,
});

// Sends an issue back through diagnosis after the gate rejected a stronger model for it, and files it under whatever cause
// diagnosis now finds, so the loop can try the cheaper surface the evidence points at.
export async function rediagnoseIssue(h: Healer, issueId: string, gateRun: GateRun): Promise<Issue> {
  const { store } = h;
  const issue = store.issues.get(issueId)!;
  const traceId = issue.traceIds.at(-1)!;
  const trace = store.trace(traceId)!;
  const live = store.liveVersion()!;
  const message = [
    '<issue>',
    describe.issue(issue),
    '</issue>',
    '',
    '<failure>',
    describe.failure(trace, store.verdictForTrace(traceId)?.checks ?? []),
    '</failure>',
    '',
    `<gate_rejection version="${gateRun.candidateVersionId}">`,
    gateRun.reasons.join('\n'),
    '</gate_rejection>',
    '',
    '<live_version>',
    describe.version(live),
    '</live_version>',
  ].join('\n');
  let result;
  try {
    result = await h.llm().json({ role: 'diagnose', model: LOOP_MODEL_ID, effort: 'medium', system: REDIAGNOSE_SYSTEM, messages: [{ role: 'user', content: message }], schema: rediagnoseSchema });
  } catch (err) {
    if (err instanceof LlmError) h.recordRun(err.run);
    throw err;
  }
  h.recordRun(result.run);
  const out = result.value;
  const { cause, scope } = checkedCause(h, live, out.cause, out.scope, out.covering_quote, issue.title);
  const updated: Issue = {
    ...issue,
    cause,
    surface: SURFACE_FOR_CAUSE[cause],
    scope: scope === 'shop' ? { kind: 'shop' } : { kind: 'customer', customerId: trace.customerId },
    diagnoseRun: result.run,
    updatedAt: now(),
  };
  store.issues.put(updated);
  h.activity(
    'diagnose',
    cause === issue.cause ? `Diagnosed again after the gate rejected a stronger model: still a ${cause} issue, so the loop stops on it` : `Diagnosed again after the gate rejected a stronger model: now a ${cause} issue (${updated.surface})`,
    { kind: 'issue', id: issue.id, label: issue.title },
  );
  h.changed('issue');
  return updated;
}
