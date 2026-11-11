import { z } from 'zod';
import type { Environment } from './env.ts';
import type { LlmTool } from './llm.ts';
import type { Guards, ToolConfig, ToolName } from './types.ts';

const orderId = z.string().describe('The order id, for example PM-1004');

export const TOOL_INPUTS = {
  list_orders: z.object({}),
  get_order: z.object({ order_id: orderId }),
  issue_refund: z.object({
    order_id: orderId,
    amount: z.number().describe('Amount to refund in USD'),
    method: z.enum(['original_payment', 'store_credit']),
    reason: z.string(),
  }),
  cancel_order: z.object({ order_id: orderId }),
  update_shipping_address: z.object({ order_id: orderId, address: z.string().describe('The full new address') }),
  escalate_to_human: z.object({ reason: z.string(), order_id: orderId.optional() }),
} satisfies Record<ToolName, z.ZodType>;

export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as ToolName[];

export function toolDefinitions(tools: ToolConfig[]): LlmTool[] {
  return tools
    .filter((t) => t.enabled)
    .map((t) => {
      const { $schema: _, ...schema } = z.toJSONSchema(TOOL_INPUTS[t.name]);
      return { name: t.name, description: t.description, input_schema: schema as LlmTool['input_schema'] };
    });
}

export interface ToolContext {
  env: Environment;
  customerId: string;
  guards: Guards;
  // Order ids returned by get_order or list_orders earlier in this trace or thread.
  lookedUp: Set<string>;
  enabled: ToolName[];
}

export interface ToolOutcome {
  output: unknown;
  isError: boolean;
  blockedByGuard: keyof Guards | null;
}

const ok = (output: unknown): ToolOutcome => ({ output, isError: false, blockedByGuard: null });
const fail = (error: string, blockedByGuard: keyof Guards | null = null): ToolOutcome => ({
  output: { error },
  isError: true,
  blockedByGuard,
});

export function executeTool(name: string, rawInput: unknown, ctx: ToolContext): ToolOutcome {
  if (!(TOOL_NAMES as string[]).includes(name) || !ctx.enabled.includes(name as ToolName)) {
    return fail(`Unknown tool ${name}`);
  }
  const parsed = TOOL_INPUTS[name as ToolName].safeParse(rawInput);
  if (!parsed.success) return fail(`Invalid input: ${z.prettifyError(parsed.error)}`);
  const input = parsed.data as Record<string, unknown>;
  const { env, guards } = ctx;

  if (name === 'list_orders') {
    const orders = env.ordersFor(ctx.customerId);
    for (const o of orders) ctx.lookedUp.add(o.id);
    return ok(orders.map((o) => ({ ...o, refunds: env.refundsFor(o.id) })));
  }

  if (name === 'escalate_to_human') {
    const id = (input.order_id as string | undefined) ?? null;
    if (id && !env.order(id)) return fail(`No order with id ${id}`);
    return ok({ escalation: env.addEscalation(ctx.customerId, id, input.reason as string) });
  }

  const id = input.order_id as string;
  const order = env.order(id);
  if (!order) return fail(`No order with id ${id}`);

  if (name === 'get_order') {
    ctx.lookedUp.add(id);
    const owner = env.customer(order.customerId);
    return ok({ ...order, owner: owner && { id: owner.id, name: owner.name, email: owner.email }, refunds: env.refundsFor(id) });
  }

  if (guards.requireOrderLookupBeforeWrite && (!ctx.lookedUp.has(id) || order.customerId !== ctx.customerId)) {
    return fail(
      `Refused: look up order ${id} with get_order first, and only act on orders that belong to the current customer.`,
      'requireOrderLookupBeforeWrite',
    );
  }

  if (name === 'cancel_order') {
    if (order.status === 'cancelled') return fail(`Order ${id} is already cancelled`);
    return ok({ order: env.cancelOrder(id) });
  }

  if (name === 'update_shipping_address') {
    const address = (input.address as string).trim();
    if (!address) return fail('The address is empty');
    return ok({ order: env.setShippingAddress(id, address) });
  }

  const amount = input.amount as number;
  if (!(amount > 0)) return fail('The refund amount must be positive');
  if (amount > order.totalPaid) return fail(`The refund amount is more than the ${order.totalPaid} paid for order ${id}`);
  if (guards.blockDuplicateRefund && env.refundsFor(id).length > 0) {
    return fail(`Refused: order ${id} already has a refund.`, 'blockDuplicateRefund');
  }
  if (guards.refundEscalationThreshold !== null && amount > guards.refundEscalationThreshold) {
    return fail(
      `Refused: refunds above ${guards.refundEscalationThreshold} need a human. Use escalate_to_human instead.`,
      'refundEscalationThreshold',
    );
  }
  return ok({ refund: env.addRefund(id, amount, input.method as 'original_payment' | 'store_credit', input.reason as string) });
}
