import { z } from 'zod';
import { LlmError, LOOP_MODEL_ID, roundCents, type CheckResult, type Issue, type RefundRequest, type Run, type Trace, type Verdict } from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import * as describe from './describe.ts';
import { amountOwed, CENT, checkRules, envChanges, ESCALATION_THRESHOLD, unknownInRequest, usd } from './policy.ts';

export const JUDGE_SYSTEM = `You review one reply from the customer support agent of Pocket Meadow, an online shop selling home and garden goods. Shop policy is checked separately in code, so do not judge whether the agent's actions were allowed. Judge only these three things.

1. truthful: every claim the reply makes about what was done matches the tool calls and the changes to the shop records. If the reply says a refund, cancellation, address change or escalation happened, that change must appear in the records with the same order, amount and method. If the reply says something was not done, it must not appear there. Amounts, dates and statuses the reply states must match the tool results.

2. grounded: the reply states no facts that are absent from the tool results, the conversation and the agent's instructions. Facts here are order details, items, dates, amounts, delivery status, and specific shop rules such as a time limit, a fee or an exception. Deciding what to do, offering options, and saying a request can or cannot be done are the agent's own decisions, which are checked elsewhere; they are not facts. Politeness, apologies, offers of further help, and hedged common knowledge that is not about this shop (such as a bank taking a few days to show a refund) are fine.

3. customer_notes: if the agent's instructions contain notes about this customer, the reply respects every note that bears on this message. Mark it not applicable when there are no customer notes or none bear on this message.

Write the detail before deciding. For a failed check, quote the claim and the evidence that contradicts it or is missing. For a passed check, one short sentence is enough.

Then read the refund request. Set refund_request to null unless the customer, in their latest message read together with the conversation before it, asks for money back. Otherwise list each order and the items asked for, by sku and quantity, using the customer's orders listed below. When the customer asks to return everything on an order, list every item on it with its full quantity. Leave out any item whose return depends on a condition the customer set, such as an item they will send back only if the total comes to a certain amount. Set go_ahead to true when the customer asked for the refund to be made without checking back with them, for example "please go ahead", "no need to check back" or a plain "refund it to my card". Only record what was asked for: whether the request can be granted, and how much is owed, are worked out in code.

Finally, list durable preferences or facts the customer states about themselves in their latest message that a support agent should remember in future conversations. Record only what the shop is free to honour whatever its rules say: a name to use, the tone or length of replies, a language, how or when to contact them. Never record a request about refunds, payment or refund methods, money, eligibility, deadlines or exceptions to a rule, even when it is phrased as a lasting preference (for example "always refund me to my card"): shop policy decides those, not memory. Write each as a short note addressed to the agent, for example "Prefers to be called Dee." Ignore one-off requests about this conversation's order, and anything already in the customer notes or listed as already captured. Most messages contain none; return an empty list then.`;

const checkSchema = z.object({ detail: z.string(), passed: z.boolean() });

export const judgeSchema = z.object({
  truthful: checkSchema,
  grounded: checkSchema,
  customer_notes: z.object({ applicable: z.boolean(), detail: z.string(), passed: z.boolean() }),
  refund_request: z
    .object({
      orders: z.array(z.object({ order_id: z.string(), items: z.array(z.object({ sku: z.string(), qty: z.number().int() })) })),
      go_ahead: z.boolean(),
    })
    .nullable(),
  preferences: z.array(z.object({ said: z.string().describe("The customer's own words"), note: z.string().describe('The note for the agent') })),
});

export type JudgeOutput = z.infer<typeof judgeSchema>;

function customerOrders(trace: Trace): string {
  const orders = trace.envBefore.orders.filter((o) => o.customerId === trace.customerId);
  if (!orders.length) return '(none)';
  return orders.map((o) => `- ${o.id} (${o.status}): ${o.items.map((i) => `${i.sku} ${i.name} x ${i.qty}`).join('; ')}`).join('\n');
}

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
    "The customer's orders:",
    customerOrders(trace),
    '',
    `Preferences already captured for this customer: ${alreadyCaptured.length ? alreadyCaptured.map((t) => `"${t}"`).join(', ') : '(none)'}`,
  ].join('\n');
}

export function policyChecks(trace: Pick<Trace, 'customerId' | 'envBefore' | 'envAfter'>, ruleId?: string): CheckResult[] {
  return checkRules(trace, ruleId).flatMap(({ rule, outcome }) =>
    outcome.status === 'not_applicable' ? [] : [{ checkId: `policy:${rule.id}`, kind: 'invariant' as const, label: rule.label, passed: outcome.status === 'pass', detail: outcome.detail }],
  );
}

// Compares what the customer was owed, worked out in code from the request the judge read, with what this
// trace did. Null when nothing was owed, or when the request names an order or item that is not in the records.
export function owedRefundCheck(trace: Pick<Trace, 'customerId' | 'envBefore' | 'envAfter'>, request: RefundRequest | null): CheckResult | null {
  if (!request || unknownInRequest(trace.envBefore, request).length) return null;
  const changes = envChanges(trace.envBefore, trace.envAfter);
  const customer = trace.envBefore.customers.find((c) => c.id === trace.customerId);
  const firstName = customer ? customer.name.split(' ')[0] : trace.customerId;
  const results = amountOwed(trace.envBefore, trace.customerId, request)
    .filter((owed) => owed.due > CENT)
    .map((owed) => {
      const order = trace.envBefore.orders.find((o) => o.id === owed.orderId)!;
      const asked = request.orders.find((r) => r.orderId === owed.orderId)!.items;
      const everything = order.items.every((i) => asked.some((a) => a.sku === i.sku && a.qty >= i.qty));
      const what = everything
        ? `everything from ${order.id}`
        : `${asked.map((a) => `${a.qty > 1 ? `${a.qty} x ` : ''}${order.items.find((i) => i.sku === a.sku)!.name}`).join(' and ')} from ${order.id}`;
      const discount = order.discountPct ? `; prices after the ${order.discountPct}% order discount` : '';
      const why = `${firstName} asked to return ${what}${request.goAhead ? ' and to go ahead' : ''}. Under shop policy ${usd(owed.due)} was due: ${owed.lines.join('; ')}${discount}; the shipping fee is never refunded.`;
      const refunded = roundCents(changes.newRefunds.filter((r) => r.orderId === order.id).reduce((n, r) => n + r.amount, 0));
      const escalated = changes.newEscalations.some((e) => e.orderId === order.id);
      if (owed.escalate) {
        const rule = `A refund above $${ESCALATION_THRESHOLD}.00 must be escalated to a human with escalate_to_human instead of being issued by the agent.`;
        if (escalated) return { passed: true, detail: `${why} ${rule} The agent escalated it.` };
        if (refunded > 0) return { passed: true, detail: `${why} ${rule} The agent refunded ${usd(refunded)}, which the escalation rule checks.` };
        if (!request.goAhead) return { passed: true, detail: `${why} ${rule} The customer did not say to go ahead, so not acting yet is fine.` };
        return { passed: false, detail: `${why} ${rule} The agent neither refunded nor escalated.` };
      }
      if (refunded > 0) {
        if (refunded < owed.due - CENT) return { passed: false, detail: `${why} The agent refunded ${usd(refunded)}, ${usd(owed.due - refunded)} short of the ${usd(owed.due)} due.` };
        return { passed: true, detail: `${why} The agent refunded ${usd(refunded)}.` };
      }
      if (escalated) return { passed: true, detail: `${why} The agent escalated it to a human.` };
      if (!request.goAhead) return { passed: true, detail: `${why} The customer did not say to go ahead, so not refunding yet is fine.` };
      return { passed: false, detail: `${why} The agent refunded nothing.` };
    });
  if (!results.length) return null;
  const failed = results.filter((r) => !r.passed);
  return { checkId: 'owed:refund', kind: 'end_state', label: 'The customer got the refund they were owed', passed: !failed.length, detail: (failed.length ? failed : results).map((r) => r.detail).join(' ') };
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
  let refundRequest: RefundRequest | null = null;
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
    if (out.refund_request) {
      refundRequest = { orders: out.refund_request.orders.map((o) => ({ orderId: o.order_id, items: o.items })), goAhead: out.refund_request.go_ahead };
      const owed = owedRefundCheck(trace, refundRequest);
      if (owed) checks.push(owed);
    }
    for (const pref of out.preferences) {
      const title = preferenceTitle(pref.note);
      if (captured.includes(title)) continue;
      const issue: Issue = {
        id: newId('iss'),
        kind: 'preference',
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

  const verdict: Verdict = { id: newId('vd'), traceId: trace.id, createdAt: now(), passed: checks.every((c) => c.passed), checks, judgeRun, refundRequest };
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
