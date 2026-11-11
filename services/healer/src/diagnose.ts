import { z } from 'zod';
import { LlmError, LOOP_MODEL_ID, type Cause, type EvalCase, type EvalCheckSpec, type Issue, type Job, type Surface, type Verdict } from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import * as describe from './describe.ts';
import { CHECK_PARAMS } from './evals.ts';

export const SURFACE_FOR_CAUSE: Record<Cause, Surface> = { knowledge: 'context', process: 'harness', capability: 'model' };

export const DIAGNOSE_SYSTEM = `You diagnose failures of the customer support agent of Pocket Meadow, an online shop selling home and garden goods. You get one failed conversation with the checks it failed, the agent version now live, and the issues already open. Decide why the agent failed, file the failure under an issue, and write a test that catches this failure if it ever happens again.

The failed checks are your evidence. A policy check's detail states the shop rule that was broken, with the real numbers; treat it as true.

Causes. Pick exactly one:
- knowledge: the agent lacked a fact about the shop's rules or about this customer. Nothing in its context notes or system prompt states the rule it broke. Fixed in the context: a shop-scope note for a shop rule, a customer-scope note for something true of this customer only.
- process: the agent had what it needed but worked in the wrong order, skipped a check (for example acting on an order without looking it up first), or needs a rule enforced in code. Fixed in the harness: the system prompt, a tool description, or a guard.
- capability: the context already states the needed rule and the harness the needed procedure, and the agent still got the reasoning or arithmetic wrong. Fixed by a stronger model.
Check the live version before choosing: if its notes already state the broken rule, the cause is not knowledge.

Scope is "customer" only when the lesson concerns this one customer. Every shop rule has scope "shop".

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

export const diagnoseSchema = z.object({
  reasoning: z.string().describe('Why the agent failed, and why this cause'),
  attach_to: z.string().nullable().describe('The id of the open issue this failure belongs to, or null to open a new issue'),
  new_issue: z
    .object({ title: z.string(), summary: z.string(), cause: z.enum(['knowledge', 'process', 'capability']), scope: z.enum(['shop', 'customer']) })
    .nullable()
    .describe('Required when attach_to is null'),
  eval_case: z.object({ title: z.string(), checks: z.array(modelCheck) }),
});

// Failed verdicts whose trace is in no issue yet. Runs that crashed are plumbing, not agent behaviour, so they are left out.
export function undiagnosed(h: Healer): Verdict[] {
  const filed = new Set(h.store.issues.list().flatMap((i) => i.traceIds));
  return h.store
    .verdicts({ passed: false })
    .reverse()
    .filter((v) => !filed.has(v.traceId) && !v.checks.some((c) => c.checkId === 'run_error'));
}

export async function diagnoseTrace(h: Healer, traceId: string): Promise<{ issue: Issue; evalCase: EvalCase; opened: boolean }> {
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
    const { title, summary, cause, scope } = out.new_issue;
    issue = {
      id: newId('iss'),
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
    origin: 'failure',
    sourceTraceId: trace.id,
    issueId: issue.id,
    customerId: trace.customerId,
    history: trace.history,
    message: trace.input,
    env: trace.envBefore,
    checks,
    enabled: true,
  };
  store.evalCases.put(evalCase);
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
