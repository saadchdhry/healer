import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import { NOTABLE_ORDERS as O, ScriptedLlm, type Environment } from '@healer/agent';
import { judgeTrace } from './judge.ts';
import { makeTrace, setupHealer } from './testing.ts';

const llm = new ScriptedLlm();
const h = setupHealer(llm);
after(() => {
  h.close();
  rmSync(h.dir, { recursive: true, force: true });
});

type Request = { orders: { order_id: string; items: { sku: string; qty: number }[] }[]; go_ahead: boolean } | null;

const ok = { detail: 'Fine.', passed: true };
const wholeOrder: Request = {
  orders: [{ order_id: O.multiRule, items: [{ sku: 'HM-LMP-1', qty: 1 }, { sku: 'GD-SUN-1', qty: 1 }, { sku: 'HM-VAS-1', qty: 2 }] }],
  go_ahead: true,
};

async function judged(customerId: string, act: (env: Environment) => void, request: Request) {
  llm.pushJson({ truthful: ok, grounded: ok, customer_notes: { applicable: false, detail: 'No notes.', passed: true }, refund_request: request, cancel_request: false, preferences: [] });
  const { verdict } = await judgeTrace(h.healer, makeTrace(customerId, act));
  return { verdict, owed: verdict.checks.find((c) => c.checkId === 'owed:refund') };
}

test('a refund short of what was owed fails and names both amounts', async () => {
  const { verdict, owed } = await judged('c_priya', (e) => e.addRefund(O.multiRule, 60, 'original_payment', 'return'), wholeOrder);
  assert.equal(owed?.passed, false);
  assert.equal(owed.kind, 'end_state');
  assert.equal(verdict.passed, false);
  for (const f of ['Priya asked to return everything from PM-1018 and to go ahead', '$72.51 was due', 'The agent refunded $60.00, $12.51 short of the $72.51 due']) {
    assert.ok(owed.detail.includes(f), `"${owed.detail}" lacks "${f}"`);
  }
  assert.deepEqual(verdict.refundRequest, { orders: [{ orderId: O.multiRule, items: wholeOrder!.orders[0]!.items }], goAhead: true });
});

test('the full amount owed passes', async () => {
  const { owed } = await judged('c_priya', (e) => e.addRefund(O.multiRule, 72.51, 'original_payment', 'return'), wholeOrder);
  assert.equal(owed?.passed, true);
});

test('no refund when the customer said to go ahead fails', async () => {
  const { owed } = await judged('c_priya', () => {}, wholeOrder);
  assert.equal(owed?.passed, false);
  assert.ok(owed.detail.endsWith('The agent refunded nothing.'), owed.detail);
});

test('no refund when the customer did not say to go ahead passes', async () => {
  const { owed } = await judged('c_priya', () => {}, { ...wholeOrder!, go_ahead: false });
  assert.equal(owed?.passed, true);
});

test('an escalation about the order passes', async () => {
  const { owed } = await judged('c_priya', (e) => e.addEscalation('c_priya', O.multiRule, 'return'), wholeOrder);
  assert.equal(owed?.passed, true);
});

test('more than $150 owed and no escalation fails', async () => {
  const { owed } = await judged('c_priya', () => {}, { orders: [{ order_id: O.highValue, items: [{ sku: 'GD-BED-1', qty: 1 }] }], go_ahead: true });
  assert.equal(owed?.passed, false);
  for (const f of ['$189.00 was due', 'must be escalated to a human', 'neither refunded nor escalated']) assert.ok(owed.detail.includes(f), `"${owed.detail}" lacks "${f}"`);
});

test('a request naming an item that is not in the records leaves the check unapplied', async () => {
  const { verdict, owed } = await judged('c_priya', () => {}, { orders: [{ order_id: O.multiRule, items: [{ sku: 'HM-XXX-9', qty: 1 }] }], go_ahead: true });
  assert.equal(owed, undefined);
  assert.equal(verdict.refundRequest?.orders[0]?.items[0]?.sku, 'HM-XXX-9');
});

test('no request for money back, and nothing owed, add no check', async () => {
  assert.equal((await judged('c_ava', () => {}, null)).owed, undefined);
  assert.equal((await judged('c_lena', () => {}, { orders: [{ order_id: O.alreadyRefunded, items: [{ sku: 'HM-CND-3', qty: 2 }] }], go_ahead: true })).owed, undefined);
});
