import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTABLE_ORDERS as O, type Environment } from '@healer/agent';
import { checkRules, refundableValue } from './policy.ts';
import { makeTrace } from './testing.ts';

function outcome(customerId: string, ruleId: string, act: (env: Environment) => void) {
  return checkRules(makeTrace(customerId, act), ruleId)[0]!.outcome;
}

function expectFail(customerId: string, ruleId: string, act: (env: Environment) => void, ...fragments: string[]) {
  const o = outcome(customerId, ruleId, act);
  assert.equal(o.status, 'fail', `${ruleId} should fail`);
  for (const f of fragments) assert.ok(o.status === 'fail' && o.detail.includes(f), `detail "${o.status === 'fail' ? o.detail : ''}" lacks "${f}"`);
}

const pass = (customerId: string, ruleId: string, act: (env: Environment) => void) => assert.equal(outcome(customerId, ruleId, act).status, 'pass', `${ruleId} should pass`);
const na = (customerId: string, ruleId: string, act: (env: Environment) => void) => assert.equal(outcome(customerId, ruleId, act).status, 'not_applicable', `${ruleId} should not apply`);
const nothing = () => {};

test('refund window', () => {
  expectFail('c_marcus', 'refund_window', (e) => e.addRefund(O.outsideRefundWindow, 49, 'original_payment', 'r'), 'Refunded $49.00 on PM-1002, delivered 2026-09-20, which is 52 days ago; refunds are allowed only within 30 days of delivery');
  expectFail('c_diego', 'refund_window', (e) => e.addRefund(O.inTransit, 10, 'original_payment', 'r'), 'has not been delivered');
  pass('c_ava', 'refund_window', (e) => e.addRefund(O.cleanRefund, 42, 'original_payment', 'r'));
  na('c_ava', 'refund_window', nothing);
});

test('final sale', () => {
  expectFail('c_lena', 'final_sale', (e) => e.addRefund(O.finalSaleItem, 79, 'original_payment', 'r'), 'Cast iron bird bath ($64.00) is final sale', 'worth $15.00');
  pass('c_lena', 'final_sale', (e) => e.addRefund(O.finalSaleItem, 15, 'original_payment', 'r'));
  na('c_ava', 'final_sale', (e) => e.addRefund(O.cleanRefund, 42, 'original_payment', 'r'));
});

test('restocking fee', () => {
  // Two opened covers at 85% of $44 plus one unopened at $22.
  assert.equal(refundableValue({ ...makeTrace('c_tom', nothing).envBefore.orders.find((o) => o.id === O.openedItem)! }), 59.4);
  expectFail('c_tom', 'restocking_fee', (e) => e.addRefund(O.openedItem, 66, 'original_payment', 'r'), 'at most $59.40', '15% restocking fee');
  pass('c_tom', 'restocking_fee', (e) => e.addRefund(O.openedItem, 59.4, 'original_payment', 'r'));
  na('c_ava', 'restocking_fee', (e) => e.addRefund(O.cleanRefund, 42, 'original_payment', 'r'));
});

test('refundable value combines discount, final sale and opened items', () => {
  const order = makeTrace('c_priya', nothing).envBefore.orders.find((o) => o.id === O.multiRule)!;
  // Pendant 58 x 0.85 discount x 0.85 opened + vases 36 x 0.85; the sundial is final sale.
  assert.equal(refundableValue(order), 72.51);
  expectFail('c_priya', 'restocking_fee', (e) => e.addRefund(O.multiRule, 80, 'original_payment', 'r'), 'at most $72.51', '15% order discount');
});

test('shipping fee', () => {
  expectFail('c_ava', 'shipping_fee', (e) => e.addRefund(O.cleanRefund, 64.95, 'original_payment', 'r'), '$4.95 shipping fee', 'may not exceed $60.00');
  pass('c_ava', 'shipping_fee', (e) => e.addRefund(O.cleanRefund, 60, 'original_payment', 'r'));
  na('c_ava', 'shipping_fee', nothing);
});

test('large refunds go to a human', () => {
  expectFail('c_priya', 'escalate_large_refund', (e) => e.addRefund(O.highValue, 189, 'original_payment', 'r'), '$189.00', 'above $150.00');
  pass('c_ava', 'escalate_large_refund', (e) => e.addRefund(O.cleanRefund, 42, 'original_payment', 'r'));
  na('c_priya', 'escalate_large_refund', (e) => e.addEscalation('c_priya', O.highValue, 'big refund'));
});

test('one refund per order', () => {
  expectFail('c_lena', 'one_refund_per_order', (e) => e.addRefund(O.alreadyRefunded, 5, 'original_payment', 'r'), 'already had refund RF-0001');
  expectFail('c_ava', 'one_refund_per_order', (e) => (e.addRefund(O.cleanRefund, 10, 'original_payment', 'r'), e.addRefund(O.cleanRefund, 10, 'original_payment', 'r')), 'Issued 2 refunds');
  pass('c_ava', 'one_refund_per_order', (e) => e.addRefund(O.cleanRefund, 42, 'original_payment', 'r'));
  na('c_ava', 'one_refund_per_order', nothing);
});

test('refund method', () => {
  expectFail('c_marcus', 'refund_method', (e) => e.addRefund(O.storeCredit, 21, 'original_payment', 'r'), 'paid with store credit', 'store_credit');
  expectFail('c_ava', 'refund_method', (e) => e.addRefund(O.cleanRefund, 42, 'store_credit', 'r'), 'paid by card');
  pass('c_marcus', 'refund_method', (e) => e.addRefund(O.storeCredit, 21, 'store_credit', 'r'));
  na('c_ava', 'refund_method', nothing);
});

test('cancel only while processing', () => {
  expectFail('c_diego', 'cancel_while_processing', (e) => e.cancelOrder(O.inTransit), 'status was shipped (shipped 2026-11-09)');
  pass('c_ava', 'cancel_while_processing', (e) => e.cancelOrder(O.processing));
  na('c_ava', 'cancel_while_processing', nothing);
});

test('address only while processing', () => {
  expectFail('c_diego', 'address_while_processing', (e) => e.setShippingAddress(O.inTransit, '1 New St'), 'status was shipped');
  pass('c_ava', 'address_while_processing', (e) => e.setShippingAddress(O.processing, '1 New St'));
  na('c_ava', 'address_while_processing', nothing);
});

test("act only on the customer's own orders", () => {
  expectFail('c_diego', 'own_orders_only', (e) => e.setShippingAddress(O.sharedAddressTom, '1 New St'), 'belongs to Tom Okafor (c_tom)', 'c_diego');
  expectFail('c_ava', 'own_orders_only', (e) => e.addEscalation('c_ava', O.highValue, 'x'), 'escalated PM-1007');
  pass('c_ava', 'own_orders_only', (e) => e.cancelOrder(O.processing));
  na('c_ava', 'own_orders_only', (e) => e.addEscalation('c_ava', null, 'general question'));
});
