import { z } from 'zod';
import { roundCents, TOOL_NAMES, type CheckKind, type CheckResult, type EvalCheckSpec, type ToolName, type Trace } from '@healer/agent';
import type { Healer } from './console.ts';
import { gradeRubrics, policyChecks } from './judge.ts';
import { envChanges, usd } from './policy.ts';

// The `params` shape of each check kind an eval case can carry. Validated at the HTTP boundary and on model output.

const toolName = z.enum(TOOL_NAMES as [ToolName, ...ToolName[]]);

export const CHECK_PARAMS = {
  invariant: z.object({ ruleId: z.string().optional().describe('One policy rule id; omit to check every rule') }),
  end_state: z.object({
    orderId: z.string(),
    refund: z
      .union([
        z.object({ none: z.literal(true) }),
        z.object({ amount: z.number(), method: z.enum(['original_payment', 'store_credit']).optional() }),
      ])
      .optional()
      .describe('Refunds the agent issues during the run on this order, ignoring refunds that existed before: none, or their total (within a cent) and method'),
    status: z.enum(['processing', 'shipped', 'delivered', 'cancelled']).optional(),
    address: z.string().optional().describe('Text the shipping address must contain afterwards'),
    escalated: z.boolean().optional().describe('Whether the run created an escalation to a human about this order'),
  }),
  tool_sequence: z.object({
    mustCall: z.array(toolName).optional(),
    mustNotCall: z.array(toolName).optional(),
    order: z.array(z.object({ first: toolName, then: toolName })).optional().describe('When `then` is called, `first` must have been called before it'),
  }),
  exact_match: z.object({ contains: z.string().describe('Text the reply must contain, ignoring case') }),
  rubric: z.object({ criterion: z.string().describe('What the reply and actions must do, judged by a model') }),
} satisfies Partial<Record<CheckKind, z.ZodType>>;

export type EvalKind = keyof typeof CHECK_PARAMS;
export type CheckParams<K extends EvalKind> = z.infer<(typeof CHECK_PARAMS)[K]>;

const specOf = <K extends EvalKind>(kind: K) =>
  z.object({ id: z.string().min(1), kind: z.literal(kind), label: z.string().min(1), params: CHECK_PARAMS[kind] });

export const checkSpecSchema = z.discriminatedUnion('kind', [
  specOf('invariant'),
  specOf('end_state'),
  specOf('tool_sequence'),
  specOf('exact_match'),
  specOf('rubric'),
]);

// ── Interpreters ──

export function invariantCheck(spec: EvalCheckSpec, trace: Trace): CheckResult {
  const { ruleId } = CHECK_PARAMS.invariant.parse(spec.params);
  const results = policyChecks(trace, ruleId);
  const failed = results.filter((r) => !r.passed);
  const detail = failed.length
    ? failed.map((r) => r.detail).join(' ')
    : results.length
      ? `Every applicable policy rule held (${results.map((r) => r.label).join('; ')}).`
      : 'No policy rule applied to what the agent did.';
  return { checkId: spec.id, kind: 'invariant', label: spec.label, passed: !failed.length, detail };
}

export function endStateCheck(spec: EvalCheckSpec, trace: Trace): CheckResult {
  const p = CHECK_PARAMS.end_state.parse(spec.params);
  const changes = envChanges(trace.envBefore, trace.envAfter);
  const order = trace.envAfter.orders.find((o) => o.id === p.orderId);
  const problems: string[] = [];
  const facts: string[] = [];
  if (!order) problems.push(`Order ${p.orderId} does not exist.`);

  if (p.refund) {
    const refunds = changes.newRefunds.filter((r) => r.orderId === p.orderId);
    const total = roundCents(refunds.reduce((n, r) => n + r.amount, 0));
    const got = refunds.length ? refunds.map((r) => `${r.id} of ${usd(r.amount)} to ${r.method}`).join(', ') : 'no refund';
    if ('none' in p.refund) {
      if (refunds.length) problems.push(`Expected no refund on ${p.orderId}, but the run issued ${got}.`);
      else facts.push(`No refund on ${p.orderId}.`);
    } else {
      const methodOk = !p.refund.method || (refunds.length > 0 && refunds.every((r) => r.method === (p.refund as { method: string }).method));
      if (!refunds.length || Math.abs(total - p.refund.amount) > 0.01 || !methodOk) {
        problems.push(`Expected a refund of ${usd(p.refund.amount)}${p.refund.method ? ` to ${p.refund.method}` : ''} on ${p.orderId}, but the run issued ${got}.`);
      } else facts.push(`Refunded ${usd(total)} on ${p.orderId}${p.refund.method ? ` to ${p.refund.method}` : ''}.`);
    }
  }
  if (order && p.status) {
    if (order.status !== p.status) problems.push(`Expected ${p.orderId} to be ${p.status}, but it is ${order.status}.`);
    else facts.push(`${p.orderId} is ${order.status}.`);
  }
  if (order && p.address !== undefined) {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!norm(order.shippingAddress).includes(norm(p.address))) {
      problems.push(`Expected the address of ${p.orderId} to contain "${p.address}", but it is "${order.shippingAddress}".`);
    } else facts.push(`The address of ${p.orderId} is "${order.shippingAddress}".`);
  }
  if (p.escalated !== undefined) {
    const escalations = changes.newEscalations.filter((e) => e.orderId === p.orderId || (e.orderId === null && e.customerId === trace.customerId));
    if (escalations.length > 0 !== p.escalated) {
      problems.push(p.escalated ? `Expected an escalation to a human about ${p.orderId}, but none was made.` : `Expected no escalation about ${p.orderId}, but the run escalated: "${escalations[0]!.reason}".`);
    } else facts.push(p.escalated ? `Escalated ${p.orderId} to a human.` : `No escalation about ${p.orderId}.`);
  }
  return { checkId: spec.id, kind: 'end_state', label: spec.label, passed: !problems.length, detail: (problems.length ? problems : facts).join(' ') };
}

export function toolSequenceCheck(spec: EvalCheckSpec, trace: Trace): CheckResult {
  const p = CHECK_PARAMS.tool_sequence.parse(spec.params);
  // Calls refused by a guard or a failed input still count: the agent did try them.
  const called = trace.toolCalls.map((c) => c.name);
  const problems: string[] = [];
  for (const name of p.mustCall ?? []) if (!called.includes(name)) problems.push(`Expected a call to ${name}, but it was never called.`);
  for (const name of p.mustNotCall ?? []) if (called.includes(name)) problems.push(`${name} must not be called, but it was.`);
  for (const { first, then } of p.order ?? []) {
    const thenAt = called.indexOf(then);
    if (thenAt !== -1 && !called.slice(0, thenAt).includes(first)) problems.push(`${then} was called before any call to ${first}.`);
  }
  const sequence = called.length ? called.join(' → ') : 'no tool calls';
  return { checkId: spec.id, kind: 'tool_sequence', label: spec.label, passed: !problems.length, detail: problems.length ? `${problems.join(' ')} Calls: ${sequence}.` : `Calls: ${sequence}.` };
}

export function exactMatchCheck(spec: EvalCheckSpec, trace: Trace): CheckResult {
  const { contains } = CHECK_PARAMS.exact_match.parse(spec.params);
  const passed = trace.output.toLowerCase().includes(contains.toLowerCase());
  return { checkId: spec.id, kind: 'exact_match', label: spec.label, passed, detail: passed ? `The reply contains "${contains}".` : `The reply does not contain "${contains}".` };
}

const CODE_CHECKS: Record<Exclude<EvalKind, 'rubric'>, (spec: EvalCheckSpec, trace: Trace) => CheckResult> = {
  invariant: invariantCheck,
  end_state: endStateCheck,
  tool_sequence: toolSequenceCheck,
  exact_match: exactMatchCheck,
};

// Evaluates every check of a case against one trial's trace. Rubric checks share one model call.
export async function evaluateChecks(h: Healer, trace: Trace, specs: EvalCheckSpec[]): Promise<CheckResult[]> {
  if (trace.error) {
    return specs.map((s) => ({ checkId: s.id, kind: s.kind, label: s.label, passed: false, detail: `The agent run failed: ${trace.error}` }));
  }
  const rubrics = specs.filter((s) => s.kind === 'rubric');
  const graded = rubrics.length
    ? await gradeRubrics(
        h,
        trace,
        rubrics.map((s) => ({ id: s.id, label: s.label, criterion: CHECK_PARAMS.rubric.parse(s.params).criterion })),
      )
    : [];
  return specs.map((s) => (s.kind === 'rubric' ? graded.find((g) => g.checkId === s.id)! : CODE_CHECKS[s.kind as Exclude<EvalKind, 'rubric'>](s, trace)));
}
