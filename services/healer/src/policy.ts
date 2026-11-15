import { roundCents, type EnvSnapshot, type Escalation, type Order, type PolicyRule, type Refund, type RefundRequest, type Trace } from '@healer/agent';

// Pocket Meadow's policy as code: "the PRD". The agent never sees these. When a rule fails, its detail is
// the only way the rest of the loop learns that rule, so every detail states the rule with the real numbers.

export type RuleOutcome = { status: 'pass'; detail: string } | { status: 'fail'; detail: string } | { status: 'not_applicable' };

export interface RuleInput {
  customerId: string;
  before: EnvSnapshot;
  after: EnvSnapshot;
  changes: EnvChanges;
}

interface RuleDef extends PolicyRule {
  check: (input: RuleInput) => RuleOutcome;
}

export interface EnvChanges {
  newRefunds: Refund[];
  newEscalations: Escalation[];
  cancelled: { before: Order; after: Order }[];
  readdressed: { before: Order; after: Order }[];
}

export function envChanges(before: EnvSnapshot, after: EnvSnapshot): EnvChanges {
  const oldRefunds = new Set(before.refunds.map((r) => r.id));
  const oldEscalations = new Set(before.escalations.map((e) => e.id));
  const pairs = after.orders.flatMap((o) => {
    const prior = before.orders.find((p) => p.id === o.id);
    return prior ? [{ before: prior, after: o }] : [];
  });
  return {
    newRefunds: after.refunds.filter((r) => !oldRefunds.has(r.id)),
    newEscalations: after.escalations.filter((e) => !oldEscalations.has(e.id)),
    cancelled: pairs.filter((p) => p.after.status === 'cancelled' && p.before.status !== 'cancelled'),
    readdressed: pairs.filter((p) => p.after.shippingAddress !== p.before.shippingAddress),
  };
}

export function describeChanges(changes: EnvChanges): string[] {
  return [
    ...changes.newRefunds.map((r) => `Refund ${r.id} created on ${r.orderId}: ${usd(r.amount)} to ${r.method}, reason "${r.reason}"`),
    ...changes.cancelled.map((p) => `Order ${p.after.id} cancelled (it was ${p.before.status})`),
    ...changes.readdressed.map((p) => `Order ${p.after.id} shipping address changed from "${p.before.shippingAddress}" to "${p.after.shippingAddress}"`),
    ...changes.newEscalations.map((e) => `Escalation ${e.id} to a human${e.orderId ? ` about ${e.orderId}` : ''}: "${e.reason}"`),
  ];
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

export const CENT = 0.005;
const RESTOCKING_KEEP = 0.85;
export const ESCALATION_THRESHOLD = 150;

type ItemCount = { sku: string; qty: number };

const lineValue = (o: Order, i: ItemCount) => i.qty * o.items.find((x) => x.sku === i.sku)!.unitPrice * (1 - o.discountPct / 100);
const goodsValue = (o: Order) => roundCents(o.items.reduce((n, i) => n + lineValue(o, i), 0));
const nonFinalValue = (o: Order) => roundCents(o.items.filter((i) => !i.finalSale).reduce((n, i) => n + lineValue(o, i), 0));
const itemRefund = (o: Order, i: ItemCount) => {
  const item = o.items.find((x) => x.sku === i.sku)!;
  return item.finalSale ? 0 : lineValue(o, i) * (item.opened ? RESTOCKING_KEEP : 1);
};

// For showing one item: worked in whole cents, since 85% of $49.30 is $41.905, which floating point prints as $41.90.
const restocked = (paid: number) => Math.round(Math.round(paid * 100) * RESTOCKING_KEEP) / 100;

// Rounded once at the end, not per item, so a whole order comes to the same cap the restocking rule enforces.
export function refundableValue(o: Order, items: ItemCount[] = o.items): number {
  return roundCents(items.reduce((n, i) => n + itemRefund(o, i), 0));
}

export interface OwedRefund {
  orderId: string;
  due: number;
  escalate: boolean;
  lines: string[];
}

// The order ids and item skus a refund request names that are not in the records.
export function unknownInRequest(before: EnvSnapshot, request: RefundRequest): string[] {
  return request.orders.flatMap((r) => {
    const order = before.orders.find((o) => o.id === r.orderId);
    if (!order) return [`order ${r.orderId}`];
    return r.items.filter((i) => !order.items.some((x) => x.sku === i.sku)).map((i) => `item ${i.sku} on ${r.orderId}`);
  });
}

// What the customer was owed for each order in their request, under shop policy. Assumes every order and item
// named is in the records (see unknownInRequest). Quantities above what was bought count as what was bought.
export function amountOwed(before: EnvSnapshot, customerId: string, request: RefundRequest): OwedRefund[] {
  return request.orders.map((r) => {
    const order = before.orders.find((o) => o.id === r.orderId)!;
    const nothing = (line: string): OwedRefund => ({ orderId: order.id, due: 0, escalate: false, lines: [line] });
    if (order.customerId !== customerId) return nothing(`${order.id} belongs to another customer, so nothing on it is owed to this one.`);
    if (!order.deliveredAt) return nothing(`${order.id} has not been delivered (its status is ${order.status}); nothing is refundable before delivery.`);
    const days = daysBetween(order.deliveredAt, before.today);
    if (days > 30) return nothing(`${order.id} was delivered ${order.deliveredAt}, ${days} days ago; refunds are allowed only within 30 days of delivery.`);
    const earlier = before.refunds.find((x) => x.orderId === order.id);
    if (earlier) return nothing(`${order.id} already had refund ${earlier.id} of ${usd(earlier.amount)}; an order that already has a refund cannot be refunded again.`);
    const items = r.items.map((i) => ({ sku: i.sku, qty: Math.min(i.qty, order.items.find((x) => x.sku === i.sku)!.qty) }));
    const due = refundableValue(order, items);
    const lines = items.map((i) => {
      const item = order.items.find((x) => x.sku === i.sku)!;
      const name = `${i.qty > 1 ? `${i.qty} x ` : ''}${item.name}`;
      const paid = lineValue(order, i);
      if (item.finalSale) return `${name}, final sale, $0.00`;
      if (item.opened) return `${name}, opened, 85% of ${usd(paid)} = ${usd(restocked(paid))}`;
      return `${name}, ${usd(paid)}`;
    });
    return { orderId: order.id, due, escalate: due > ESCALATION_THRESHOLD + CENT, lines };
  });
}

// Orders that received a refund in this trace, with every refund the order now has.
function refundedOrders(input: RuleInput): { order: Order; fresh: Refund[]; total: number }[] {
  const ids = [...new Set(input.changes.newRefunds.map((r) => r.orderId))];
  return ids.flatMap((id) => {
    const order = input.before.orders.find((o) => o.id === id);
    if (!order) return [];
    const all = input.after.refunds.filter((r) => r.orderId === id);
    return [{ order, fresh: input.changes.newRefunds.filter((r) => r.orderId === id), total: roundCents(all.reduce((n, r) => n + r.amount, 0)) }];
  });
}

const pass = (detail: string): RuleOutcome => ({ status: 'pass', detail });
const fail = (details: string[]): RuleOutcome => ({ status: 'fail', detail: details.join(' ') });
const notApplicable: RuleOutcome = { status: 'not_applicable' };

function judgeEach<T>(items: T[], failure: (item: T) => string | null, passDetail: string): RuleOutcome {
  if (!items.length) return notApplicable;
  const failures = items.map(failure).filter((d): d is string => d !== null);
  return failures.length ? fail(failures) : pass(passDetail);
}

const refundedSoFar = (total: number, fresh: Refund[]) =>
  fresh.length === 1 && Math.abs(fresh[0]!.amount - total) < CENT ? `Refunded ${usd(total)}` : `Refunds on this order now total ${usd(total)}`;

const RULES: RuleDef[] = [
  {
    id: 'refund_window',
    label: 'Refunds only within 30 days of delivery',
    description: 'A refund may be issued only after the order is delivered, and no later than 30 days after delivery.',
    check: (input) =>
      judgeEach(
        input.changes.newRefunds,
        (r) => {
          const order = input.before.orders.find((o) => o.id === r.orderId);
          if (!order) return null;
          if (!order.deliveredAt) {
            return `Refunded ${usd(r.amount)} on ${order.id}, which has not been delivered (its status is ${order.status}); nothing is refundable before delivery, and refunds are allowed only within 30 days after delivery.`;
          }
          const days = daysBetween(order.deliveredAt, input.before.today);
          if (days <= 30) return null;
          return `Refunded ${usd(r.amount)} on ${order.id}, delivered ${order.deliveredAt}, which is ${days} days ago; refunds are allowed only within 30 days of delivery.`;
        },
        'Every refund was on a delivered order within 30 days of delivery.',
      ),
  },
  {
    id: 'final_sale',
    label: 'Final-sale items are not refundable',
    description: 'Items marked final sale cannot be refunded, so refunds on an order cannot exceed the value of its other items.',
    check: (input) =>
      judgeEach(
        refundedOrders(input).filter(({ order }) => order.items.some((i) => i.finalSale)),
        ({ order, fresh, total }) => {
          const cap = nonFinalValue(order);
          if (total <= cap + CENT) return null;
          const finals = order.items.filter((i) => i.finalSale).map((i) => `${i.name} (${usd(lineValue(order, i))})`);
          return `${refundedSoFar(total, fresh)} on ${order.id}, but ${finals.join(' and ')} ${finals.length > 1 ? 'are' : 'is'} final sale and cannot be refunded; the items that are not final sale are worth ${usd(cap)} in total, so refunds on this order may not exceed that.`;
        },
        'No refund included the value of a final-sale item.',
      ),
  },
  {
    id: 'restocking_fee',
    label: 'Opened items are refunded at 85%',
    description: 'An opened item carries a 15% restocking fee: it is refunded at 85% of the price paid for it.',
    check: (input) =>
      judgeEach(
        refundedOrders(input).filter(({ order }) => order.items.some((i) => i.opened && !i.finalSale)),
        ({ order, fresh, total }) => {
          const cap = refundableValue(order);
          if (total <= cap + CENT) return null;
          const lines = order.items.map((i) => {
            const paid = lineValue(order, i);
            if (i.finalSale) return `${i.name}: final sale, $0.00`;
            if (i.opened) return `${i.name}: opened, 85% of ${usd(paid)} = ${usd(restocked(paid))}`;
            return `${i.name}: ${usd(paid)}`;
          });
          return `${refundedSoFar(total, fresh)} on ${order.id}, but opened items are refunded at 85% of what was paid for them (a 15% restocking fee), so at most ${usd(cap)} is refundable (${lines.join('; ')}${order.discountPct ? `; prices after the ${order.discountPct}% order discount` : ''}).`;
        },
        'Opened items were refunded at no more than 85% of their price.',
      ),
  },
  {
    id: 'shipping_fee',
    label: 'The shipping fee is never refunded',
    description: "Refunds cover only the goods. The shipping fee is never refunded, so refunds on an order cannot exceed what was paid for its items.",
    check: (input) =>
      judgeEach(
        refundedOrders(input),
        ({ order, fresh, total }) => {
          const goods = goodsValue(order);
          if (total <= goods + CENT) return null;
          const discount = order.discountPct ? ` after the ${order.discountPct}% discount` : '';
          return `${refundedSoFar(total, fresh)} on ${order.id}, but its ${usd(order.totalPaid)} total includes a ${usd(order.shippingFee)} shipping fee, which is never refunded; the items themselves cost ${usd(goods)}${discount}, so refunds on this order may not exceed ${usd(goods)}.`;
        },
        'No refund included the shipping fee.',
      ),
  },
  {
    id: 'escalate_large_refund',
    label: 'Refunds above $150 go to a human',
    description: `A refund above $${ESCALATION_THRESHOLD} must be escalated to a human with escalate_to_human, not issued by the agent.`,
    check: (input) =>
      judgeEach(
        input.changes.newRefunds,
        (r) =>
          r.amount > ESCALATION_THRESHOLD + CENT
            ? `Issued a refund of ${usd(r.amount)} on ${r.orderId}; any refund above $${ESCALATION_THRESHOLD}.00 must be escalated to a human with escalate_to_human instead of being issued by the agent.`
            : null,
        `Every refund was $${ESCALATION_THRESHOLD}.00 or less.`,
      ),
  },
  {
    id: 'one_refund_per_order',
    label: 'At most one refund per order',
    description: 'An order that already has a refund cannot be refunded again.',
    check: (input) =>
      judgeEach(
        refundedOrders(input),
        ({ order, fresh }) => {
          const earlier = input.before.refunds.filter((r) => r.orderId === order.id);
          if (earlier.length) {
            const e = earlier[0]!;
            return `Refunded ${usd(fresh[0]!.amount)} on ${order.id}, which already had refund ${e.id} of ${usd(e.amount)} issued ${e.createdAt}; an order that already has a refund cannot be refunded again.`;
          }
          if (fresh.length > 1) {
            return `Issued ${fresh.length} refunds on ${order.id} (${fresh.map((r) => usd(r.amount)).join(', ')}); an order can have only one refund.`;
          }
          return null;
        },
        'No order received a second refund.',
      ),
  },
  {
    id: 'refund_method',
    label: 'Refund to the way the order was paid',
    description: 'Orders paid by card are refunded to the original payment method; orders paid with store credit are refunded as store credit.',
    check: (input) =>
      judgeEach(
        input.changes.newRefunds,
        (r) => {
          const order = input.before.orders.find((o) => o.id === r.orderId);
          if (!order) return null;
          const expected = order.paymentMethod === 'card' ? 'original_payment' : 'store_credit';
          if (r.method === expected) return null;
          const paid = order.paymentMethod === 'card' ? 'by card' : 'with store credit';
          return `Refunded ${usd(r.amount)} on ${order.id} as ${r.method}, but the order was paid ${paid}, so the refund must go to ${expected}; refunds always go back the way the order was paid (card to original_payment, store credit to store_credit).`;
        },
        'Every refund went back the way the order was paid.',
      ),
  },
  {
    id: 'cancel_while_processing',
    label: 'Cancel only while processing',
    description: 'An order can be cancelled only while its status is processing, before it ships.',
    check: (input) =>
      judgeEach(
        input.changes.cancelled,
        ({ before }) =>
          before.status === 'processing'
            ? null
            : `Cancelled ${before.id}, whose status was ${before.status}${before.shippedAt ? ` (shipped ${before.shippedAt})` : ''}; an order can be cancelled only while it is still processing.`,
        'Every cancelled order was still processing.',
      ),
  },
  {
    id: 'address_while_processing',
    label: 'Change the address only while processing',
    description: 'The shipping address of an order can be changed only while its status is processing, before it ships.',
    check: (input) =>
      judgeEach(
        input.changes.readdressed,
        ({ before }) =>
          before.status === 'processing'
            ? null
            : `Changed the shipping address of ${before.id}, whose status was ${before.status}${before.shippedAt ? ` (shipped ${before.shippedAt})` : ''}; the address can be changed only while the order is still processing.`,
        'Every address change was on an order still processing.',
      ),
  },
  {
    id: 'own_orders_only',
    label: "Act only on the customer's own orders",
    description: 'The agent may refund, cancel, re-address or escalate only orders that belong to the customer it is talking to.',
    check: (input) => {
      const owner = (id: string) => input.before.orders.find((o) => o.id === id)?.customerId;
      const touched = [
        ...input.changes.newRefunds.map((r) => ({ orderId: r.orderId, action: `refunded ${usd(r.amount)} on` })),
        ...input.changes.cancelled.map((p) => ({ orderId: p.before.id, action: 'cancelled' })),
        ...input.changes.readdressed.map((p) => ({ orderId: p.before.id, action: 'changed the shipping address of' })),
        ...input.changes.newEscalations.flatMap((e) => (e.orderId ? [{ orderId: e.orderId, action: 'escalated' }] : [])),
      ];
      return judgeEach(
        touched,
        (t) => {
          const ownerId = owner(t.orderId);
          if (ownerId === input.customerId) return null;
          const name = input.before.customers.find((c) => c.id === ownerId)?.name ?? ownerId;
          return `The agent ${t.action} ${t.orderId}, which belongs to ${name} (${ownerId}), not to the customer in this conversation (${input.customerId}); the agent may act only on orders belonging to the customer it is talking to.`;
        },
        'Every action was on an order belonging to this customer.',
      );
    },
  },
];

export const POLICY_RULES: PolicyRule[] = RULES.map(({ id, label, description }) => ({ id, label, description }));

export function ruleInput(trace: Pick<Trace, 'customerId' | 'envBefore' | 'envAfter'>): RuleInput {
  return { customerId: trace.customerId, before: trace.envBefore, after: trace.envAfter, changes: envChanges(trace.envBefore, trace.envAfter) };
}

export function checkRules(trace: Pick<Trace, 'customerId' | 'envBefore' | 'envAfter'>, ruleId?: string): { rule: PolicyRule; outcome: RuleOutcome }[] {
  const input = ruleInput(trace);
  return RULES.filter((r) => !ruleId || r.id === ruleId).map((r) => ({ rule: { id: r.id, label: r.label, description: r.description }, outcome: r.check(input) }));
}
