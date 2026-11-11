import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Environment, NOTABLE_ORDERS, orderTotal, seedSnapshot, SEED_TODAY } from './env.ts';
import { executeTool, toolDefinitions, type ToolContext } from './tools.ts';
import { factoryVersion } from './supportAgent.ts';
import type { Guards } from './types.ts';

const noGuards: Guards = { requireOrderLookupBeforeWrite: false, blockDuplicateRefund: false, refundEscalationThreshold: null };

function ctx(customerId: string, guards: Partial<Guards> = {}): ToolContext {
  return {
    env: new Environment(seedSnapshot()),
    customerId,
    guards: { ...noGuards, ...guards },
    lookedUp: new Set(),
    enabled: factoryVersion().harness.tools.map((t) => t.name),
  };
}

const daysAgo = (date: string) => (Date.parse(SEED_TODAY) - Date.parse(date)) / 86_400_000;

test('seed: totalPaid matches items, discount and shipping for every order', () => {
  const snap = seedSnapshot();
  assert.equal(snap.today, '2026-11-11');
  assert.equal(snap.customers.length, 6);
  assert.ok(snap.orders.length >= 18 && snap.orders.length <= 22);
  for (const o of snap.orders) {
    const expected = Math.round(
      (o.items.reduce((s, i) => s + i.qty * i.unitPrice * (1 - o.discountPct / 100), 0) + o.shippingFee) * 100,
    ) / 100;
    assert.equal(o.totalPaid, expected, o.id);
    assert.equal(o.totalPaid, orderTotal(o.items, o.discountPct, o.shippingFee));
  }
});

test('seed: every notable situation is present', () => {
  const snap = seedSnapshot();
  const get = (id: string) => snap.orders.find((o) => o.id === id)!;
  const clean = get(NOTABLE_ORDERS.cleanRefund);
  assert.ok(daysAgo(clean.deliveredAt!) >= 5 && daysAgo(clean.deliveredAt!) <= 20);
  assert.ok(clean.items.every((i) => !i.opened && !i.finalSale) && clean.paymentMethod === 'card');
  assert.ok(daysAgo(get(NOTABLE_ORDERS.outsideRefundWindow).deliveredAt!) >= 40);
  assert.ok(get(NOTABLE_ORDERS.highValue).totalPaid > 150);
  assert.ok(get(NOTABLE_ORDERS.openedItem).items.some((i) => i.opened));
  assert.ok(get(NOTABLE_ORDERS.finalSaleItem).items.some((i) => i.finalSale));
  assert.equal(get(NOTABLE_ORDERS.inTransit).status, 'shipped');
  assert.equal(get(NOTABLE_ORDERS.processing).status, 'processing');
  assert.equal(get(NOTABLE_ORDERS.storeCredit).paymentMethod, 'store_credit');
  assert.ok(snap.refunds.some((r) => r.orderId === NOTABLE_ORDERS.alreadyRefunded));
  const multi = get(NOTABLE_ORDERS.multiRule);
  assert.ok(multi.discountPct > 0 && multi.items.some((i) => i.opened) && multi.items.some((i) => i.finalSale));
  assert.ok(multi.items.some((i) => !i.opened && !i.finalSale));
  assert.notEqual(get(NOTABLE_ORDERS.sharedAddressTom).customerId, get(NOTABLE_ORDERS.sharedAddressDiego).customerId);
});

test('environment copies in and out', () => {
  const snap = seedSnapshot();
  const env = new Environment(snap);
  snap.orders[0]!.status = 'cancelled';
  assert.notEqual(env.order(snap.orders[0]!.id)!.status, 'cancelled');
  env.snapshot().orders.length = 0;
  assert.ok(env.snapshot().orders.length > 0);
});

test('tool definitions follow the version config and drop disabled tools', () => {
  const tools = factoryVersion().harness.tools.map((t) => (t.name === 'cancel_order' ? { ...t, enabled: false } : t));
  const defs = toolDefinitions(tools);
  assert.equal(defs.length, 5);
  assert.ok(!defs.some((d) => d.name === 'cancel_order'));
  const refund = defs.find((d) => d.name === 'issue_refund')!;
  assert.equal(refund.description, 'Issue a refund on an order.');
  assert.deepEqual(refund.input_schema.required, ['order_id', 'amount', 'method', 'reason']);
});

test('without guards the write tools enforce no policy', () => {
  const c = ctx('c_ava');
  const refund = executeTool('issue_refund', { order_id: NOTABLE_ORDERS.outsideRefundWindow, amount: 10, method: 'original_payment', reason: 'x' }, c);
  assert.equal(refund.isError, false);
  const dup = executeTool('issue_refund', { order_id: NOTABLE_ORDERS.alreadyRefunded, amount: 5, method: 'store_credit', reason: 'x' }, c);
  assert.equal(dup.isError, false);
  assert.equal(executeTool('cancel_order', { order_id: NOTABLE_ORDERS.cleanRefund }, c).isError, false);
  assert.equal(c.env.refundsFor(NOTABLE_ORDERS.alreadyRefunded).length, 2);
});

test('tools reject what is technically impossible', () => {
  const c = ctx('c_ava');
  assert.equal(executeTool('get_order', { order_id: 'PM-9999' }, c).isError, true);
  assert.equal(executeTool('issue_refund', { order_id: NOTABLE_ORDERS.cleanRefund, amount: 0, method: 'store_credit', reason: 'x' }, c).isError, true);
  assert.equal(executeTool('issue_refund', { order_id: NOTABLE_ORDERS.cleanRefund, amount: 'ten', method: 'store_credit', reason: 'x' }, c).isError, true);
  assert.equal(executeTool('nope', {}, c).isError, true);
  c.enabled = c.enabled.filter((n) => n !== 'cancel_order');
  assert.equal(executeTool('cancel_order', { order_id: NOTABLE_ORDERS.processing }, c).isError, true);
});

test('get_order returns the owner and refunds; list_orders lists only the current customer', () => {
  const c = ctx('c_tom');
  const got = executeTool('get_order', { order_id: NOTABLE_ORDERS.sharedAddressDiego }, c).output as { owner: { id: string }; refunds: unknown[] };
  assert.equal(got.owner.id, 'c_diego');
  assert.deepEqual(got.refunds, []);
  const listed = executeTool('list_orders', {}, c).output as { customerId: string }[];
  assert.ok(listed.length > 0 && listed.every((o) => o.customerId === 'c_tom'));
});

test('guard: requireOrderLookupBeforeWrite', () => {
  const c = ctx('c_tom', { requireOrderLookupBeforeWrite: true });
  const before = executeTool('cancel_order', { order_id: NOTABLE_ORDERS.sharedAddressTom }, c);
  assert.equal(before.blockedByGuard, 'requireOrderLookupBeforeWrite');
  executeTool('get_order', { order_id: NOTABLE_ORDERS.sharedAddressDiego }, c);
  const notOwner = executeTool('update_shipping_address', { order_id: NOTABLE_ORDERS.sharedAddressDiego, address: '1 New St' }, c);
  assert.equal(notOwner.blockedByGuard, 'requireOrderLookupBeforeWrite');
  executeTool('list_orders', {}, c);
  assert.equal(executeTool('cancel_order', { order_id: NOTABLE_ORDERS.sharedAddressTom }, c).isError, false);
});

test('guard: blockDuplicateRefund', () => {
  const c = ctx('c_lena', { blockDuplicateRefund: true });
  const r = executeTool('issue_refund', { order_id: NOTABLE_ORDERS.alreadyRefunded, amount: 5, method: 'store_credit', reason: 'x' }, c);
  assert.equal(r.blockedByGuard, 'blockDuplicateRefund');
  assert.equal(c.env.refundsFor(NOTABLE_ORDERS.alreadyRefunded).length, 1);
});

test('guard: refundEscalationThreshold', () => {
  const c = ctx('c_priya', { refundEscalationThreshold: 150 });
  const big = executeTool('issue_refund', { order_id: NOTABLE_ORDERS.highValue, amount: 189, method: 'original_payment', reason: 'x' }, c);
  assert.equal(big.blockedByGuard, 'refundEscalationThreshold');
  assert.match((big.output as { error: string }).error, /escalate_to_human/);
  const small = executeTool('issue_refund', { order_id: NOTABLE_ORDERS.highValue, amount: 100, method: 'original_payment', reason: 'x' }, c);
  assert.equal(small.isError, false);
});
