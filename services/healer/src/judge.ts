import { z } from 'zod';
import { LlmError, LOOP_MODEL_ID, type CheckResult, type Issue, type Run, type Trace, type Verdict } from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import * as describe from './describe.ts';
import { checkRules } from './policy.ts';

export const JUDGE_SYSTEM = `You review one reply from the customer support agent of Pocket Meadow, an online shop selling home and garden goods. Shop policy is checked separately in code, so do not judge whether the agent's actions were allowed. Judge only these three things.

1. truthful: every claim the reply makes about what was done matches the tool calls and the changes to the shop records. If the reply says a refund, cancellation, address change or escalation happened, that change must appear in the records with the same order, amount and method. If the reply says something was not done, it must not appear there. Amounts, dates and statuses the reply states must match the tool results.

2. grounded: the reply states no facts that are absent from the tool results, the conversation and the agent's instructions. Facts here are order details, items, dates, amounts, delivery status, and specific shop rules such as a time limit, a fee or an exception. Deciding what to do, offering options, and saying a request can or cannot be done are the agent's own decisions, which are checked elsewhere; they are not facts. Politeness, apologies, offers of further help, and hedged common knowledge that is not about this shop (such as a bank taking a few days to show a refund) are fine.

3. customer_notes: if the agent's instructions contain notes about this customer, the reply respects every note that bears on this message. Mark it not applicable when there are no customer notes or none bear on this message.

Write the detail before deciding. For a failed check, quote the claim and the evidence that contradicts it or is missing. For a passed check, one short sentence is enough.

Finally, list durable preferences or facts the customer states about themselves in their latest message that a support agent should remember in future conversations, such as "always refund me to store credit" or "call me Dee". Write each as a short note addressed to the agent, for example "Prefers to be called Dee." Ignore one-off requests about this conversation's order, and anything already in the customer notes or listed as already captured. Most messages contain none; return an empty list then.`;

const checkSchema = z.object({ detail: z.string(), passed: z.boolean() });

export const judgeSchema = z.object({
  truthful: checkSchema,
  grounded: checkSchema,
  customer_notes: z.object({ applicable: z.boolean(), detail: z.string(), passed: z.boolean() }),
  preferences: z.array(z.object({ said: z.string().describe("The customer's own words"), note: z.string().describe('The note for the agent') })),
});

export type JudgeOutput = z.infer<typeof judgeSchema>;

function judgeMessage(trace: Trace, alreadyCaptured: string[]): string {
  return [
    '<agent_instructions>',
    describe.agentSystemPrompt(trace) ?? '(not recorded)',
    '</agent_instructions>',
    '',
    describe.customerLine(trace),
    '',
    'Conversation:',
    describe.conversation(trace.history, trace.input),
    '',
    'Tool calls:',
    describe.toolCalls(trace),
    '',
    'Changes to the shop records:',
    describe.changes(trace),
    '',
    `Agent reply: ${trace.output}`,
    '',
    `Preferences already captured for this customer: ${alreadyCaptured.length ? alreadyCaptured.map((t) => `"${t}"`).join(', ') : '(none)'}`,
  ].join('\n');
}

export function policyChecks(trace: Pick<Trace, 'customerId' | 'envBefore' | 'envAfter'>, ruleId?: string): CheckResult[] {
  return checkRules(trace, ruleId).flatMap(({ rule, outcome }) =>
    outcome.status === 'not_applicable' ? [] : [{ checkId: `policy:${rule.id}`, kind: 'invariant' as const, label: rule.label, passed: outcome.status === 'pass', detail: outcome.detail }],
  );
}

export function runErrorCheck(trace: Trace): CheckResult {
  return { checkId: 'run_error', kind: 'invariant', label: 'The agent run completed', passed: false, detail: `The agent run failed before replying: ${trace.error}` };
}

const preferenceTitle = (note: string) => `Remember for this customer: ${note}`;

// The judge entry point: policy rules in code, one model call for what code cannot check, and any customer
// preferences turned into issues so user-level memory flows through the same pipeline.
export async function judgeTrace(h: Healer, trace: Trace): Promise<{ verdict: Verdict; preferenceIssues: Issue[] }> {
  const { store } = h;
  const checks: CheckResult[] = policyChecks(trace);
  let judgeRun: Run | null = null;
  const preferenceIssues: Issue[] = [];

  if (trace.error) {
    checks.push(runErrorCheck(trace));
  } else {
    const captured = store.issues
      .list()
      .filter((i) => i.scope.kind === 'customer' && i.scope.customerId === trace.customerId && i.status !== 'dismissed')
      .map((i) => i.title);
    let out: JudgeOutput;
    try {
      const result = await h.llm().json({
        role: 'judge',
        model: LOOP_MODEL_ID,
        effort: 'low',
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: judgeMessage(trace, captured) }],
        schema: judgeSchema,
      });
      judgeRun = result.run;
      out = result.value;
    } catch (err) {
      if (err instanceof LlmError) h.recordRun(err.run);
      throw err;
    }
    h.recordRun(judgeRun);
    checks.push(
      { checkId: 'judge:truthful', kind: 'rubric', label: 'The reply is truthful about what was done', passed: out.truthful.passed, detail: out.truthful.detail },
      { checkId: 'judge:grounded', kind: 'rubric', label: 'The reply invents no facts', passed: out.grounded.passed, detail: out.grounded.detail },
    );
    if (out.customer_notes.applicable) {
      checks.push({ checkId: 'judge:customer_notes', kind: 'rubric', label: 'The reply honours the notes about this customer', passed: out.customer_notes.passed, detail: out.customer_notes.detail });
    }
    for (const pref of out.preferences) {
      const title = preferenceTitle(pref.note);
      if (captured.includes(title)) continue;
      const issue: Issue = {
        id: newId('iss'),
        createdAt: now(),
        updatedAt: now(),
        title,
        summary: `The customer said: "${pref.said}". Save this for future conversations with this customer only.`,
        cause: 'knowledge',
        surface: 'context',
        scope: { kind: 'customer', customerId: trace.customerId },
        status: 'open',
        traceIds: [trace.id],
        evalCaseIds: [],
        proposalIds: [],
        diagnoseRun: judgeRun,
      };
      store.issues.put(issue);
      preferenceIssues.push(issue);
      h.activity('judge', `Customer preference noted: ${pref.note}`, { kind: 'issue', id: issue.id, label: issue.title });
    }
  }

  const rating = store.rating(trace.id);
  if (rating) {
    checks.push({
      checkId: 'feedback',
      kind: 'feedback',
      label: 'The customer rated the reply',
      passed: rating === 'up',
      detail: rating === 'up' ? 'The customer gave this reply a thumbs up.' : 'The customer gave this reply a thumbs down.',
    });
  }

  const verdict: Verdict = { id: newId('vd'), traceId: trace.id, createdAt: now(), passed: checks.every((c) => c.passed), checks, judgeRun };
  store.saveVerdict(verdict);
  const failed = checks.filter((c) => !c.passed).map((c) => c.label);
  h.activity(
    'judge',
    verdict.passed ? `Passed: "${trace.input.slice(0, 60)}"` : `Failed (${failed.join('; ')}): "${trace.input.slice(0, 60)}"`,
    { kind: 'verdict', id: verdict.id, label: verdict.passed ? 'pass' : 'fail' },
  );
  h.changed('verdict', 'trace', ...(preferenceIssues.length ? (['issue'] as const) : []));
  return { verdict, preferenceIssues };
}

// ── Rubric grading for eval cases: one call per trial covering every rubric check of the case ──

export const RUBRIC_SYSTEM = `You grade one reply from the customer support agent of Pocket Meadow, an online shop, against a list of criteria. You see the conversation, the agent's tool calls, the changes it made to the shop records, and its reply. For each criterion, decide whether the agent's reply and actions meet it. Judge the substance, not the wording: a reply meets a criterion if a careful reader would agree it does what the criterion asks. Write the detail before deciding, and quote the reply where it matters.`;

export const rubricSchema = z.object({
  results: z.array(z.object({ id: z.string(), detail: z.string(), passed: z.boolean() })),
});

export async function gradeRubrics(h: Healer, trace: Trace, criteria: { id: string; label: string; criterion: string }[]): Promise<CheckResult[]> {
  const message = [
    describe.customerLine(trace),
    '',
    'Conversation:',
    describe.conversation(trace.history, trace.input),
    '',
    'Tool calls:',
    describe.toolCalls(trace),
    '',
    'Changes to the shop records:',
    describe.changes(trace),
    '',
    `Agent reply: ${trace.output}`,
    '',
    'Criteria:',
    ...criteria.map((c) => `- [${c.id}] ${c.criterion}`),
  ].join('\n');
  let value: z.infer<typeof rubricSchema>;
  try {
    const result = await h.llm().json({ role: 'judge', model: LOOP_MODEL_ID, effort: 'low', system: RUBRIC_SYSTEM, messages: [{ role: 'user', content: message }], schema: rubricSchema });
    h.recordRun(result.run);
    value = result.value;
  } catch (err) {
    if (err instanceof LlmError) h.recordRun(err.run);
    throw err;
  }
  return criteria.map((c) => {
    const r = value.results.find((x) => x.id === c.id);
    return { checkId: c.id, kind: 'rubric', label: c.label, passed: r?.passed ?? false, detail: r?.detail ?? 'The grader returned no result for this criterion.' };
  });
}
