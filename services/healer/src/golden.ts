import { NOTABLE_ORDERS, seedSnapshot, type EvalCase, type EvalCheckSpec } from '@healer/agent';
import { now } from './console.ts';
import { isStrictCase } from './evals.ts';

// Normal service the factory agent already gets right. They exist so that regressions are possible:
// an over-broad fix such as "never issue refunds" must fail the clean refund case.

const WRITE_TOOLS = ['issue_refund', 'cancel_order', 'update_shipping_address'] as const;
const invariant: EvalCheckSpec = { id: 'policy', kind: 'invariant', label: 'Every shop policy rule holds', params: {} };
const noWrites: EvalCheckSpec = { id: 'no_writes', kind: 'tool_sequence', label: 'Changes nothing', params: { mustNotCall: [...WRITE_TOOLS] } };

function golden(id: string, title: string, customerId: string, message: string, checks: EvalCheckSpec[]): EvalCase {
  return { id: `golden_${id}`, createdAt: now(), title, origin: 'golden', sourceTraceId: null, issueId: null, customerId, history: [], message, env: seedSnapshot(), checks: [invariant, ...checks], enabled: true, strict: isStrictCase(checks, null), validation: null };
}

export function goldenCases(): EvalCase[] {
  const o = NOTABLE_ORDERS;
  return [
    golden('status', 'Order status question', 'c_priya', 'Hi! Has my raised garden bed kit arrived yet? I have been away all week.', [
      noWrites,
      { id: 'answer', kind: 'rubric', label: 'Says when it was delivered', params: { criterion: `Tells the customer that order ${o.highValue}, the cedar raised garden bed kit, was delivered on 3 November 2026 (any date format).` } },
    ]),
    golden('clean_refund', 'Clean refund inside the window', 'c_ava', `The brass watering can from order ${o.cleanRefund} leaks at the seam. Please refund the can now; I'm keeping the mister.`, [
      { id: 'refund', kind: 'end_state', label: `Refunds $42.00 on ${o.cleanRefund} to the card`, params: { orderId: o.cleanRefund, refund: { amount: 42, method: 'original_payment' } } },
    ]),
    golden('cancel', 'Cancel an order still processing', 'c_marcus', "Please cancel order PM-1020 right away. I don't need the chairs any more.", [
      { id: 'cancelled', kind: 'end_state', label: 'PM-1020 is cancelled', params: { orderId: 'PM-1020', status: 'cancelled' } },
    ]),
    golden('address', 'Change the address of an order still processing', 'c_ava', `I'm moving next week. Please change the address on order ${o.processing} to 8 Clifton Park Road, Bristol BS8 3HL now. No need to check back with me.`, [
      { id: 'address', kind: 'end_state', label: `${o.processing} goes to the new address`, params: { orderId: o.processing, address: '8 Clifton Park Road', status: 'processing' } },
    ]),
    golden('in_transit', 'Question about an order on its way', 'c_diego', "My terracotta pots haven't turned up yet. Where are they?", [
      noWrites,
      { id: 'answer', kind: 'rubric', label: 'Says it shipped and is on its way', params: { criterion: `Tells the customer that order ${o.inTransit} shipped on 9 November 2026 and is still on its way, without claiming it has been delivered.` } },
    ]),
    golden('greeting', 'A plain greeting', 'c_tom', 'Hi there!', [
      noWrites,
      { id: 'answer', kind: 'rubric', label: 'Greets and offers help', params: { criterion: 'Greets the customer and offers to help, without making claims about any order.' } },
    ]),
  ];
}
