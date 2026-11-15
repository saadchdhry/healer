import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTABLE_ORDERS as O, ScriptedLlm, seedSnapshot, type EvalCheckSpec, type ToolCallRecord } from '@healer/agent';
import { checkConflicts, checkSpecSchema, endStateCheck, evaluateChecks, exactMatchCheck, invariantCheck, toolSequenceCheck } from './evals.ts';
import { runSuite } from './evalRunner.ts';
import { makeTrace, setupHealer, waitFor } from './testing.ts';

const spec = (kind: EvalCheckSpec['kind'], params: Record<string, unknown>): EvalCheckSpec => ({ id: 'c', kind, label: 'check', params });
const call = (name: ToolCallRecord['name'], input: Record<string, unknown> = {}): ToolCallRecord => ({ runId: 'r', name, input, output: {}, blockedByGuard: null });

test('invariant: all rules or one rule', () => {
  const late = makeTrace('c_marcus', (e) => e.addRefund(O.outsideRefundWindow, 53.95, 'original_payment', 'r'));
  const all = invariantCheck(spec('invariant', {}), late);
  assert.equal(all.passed, false);
  assert.match(all.detail, /52 days ago/);
  assert.match(all.detail, /shipping fee/);
  assert.equal(invariantCheck(spec('invariant', { ruleId: 'refund_method' }), late).passed, true);
  assert.match(invariantCheck(spec('invariant', {}), makeTrace('c_ava', () => {})).detail, /No policy rule applied/);
});

test('end_state: refunds, status, address, escalation', () => {
  const refunded = makeTrace('c_ava', (e) => e.addRefund(O.cleanRefund, 42, 'original_payment', 'r'));
  assert.equal(endStateCheck(spec('end_state', { orderId: O.cleanRefund, refund: { amount: 42.004, method: 'original_payment' } }), refunded).passed, true);
  assert.equal(endStateCheck(spec('end_state', { orderId: O.cleanRefund, refund: { amount: 42, method: 'store_credit' } }), refunded).passed, false);
  assert.equal(endStateCheck(spec('end_state', { orderId: O.cleanRefund, refund: { amount: 60 } }), refunded).passed, false);
  const none = endStateCheck(spec('end_state', { orderId: O.cleanRefund, refund: { none: true } }), refunded);
  assert.equal(none.passed, false);
  assert.match(none.detail, /Expected no refund on PM-1004, but the run issued RF-0002 of \$42.00/);
  // The seed's existing refund on PM-1006 is not new, so "none" holds.
  assert.equal(endStateCheck(spec('end_state', { orderId: O.alreadyRefunded, refund: { none: true } }), refunded).passed, true);

  const moved = makeTrace('c_ava', (e) => (e.setShippingAddress(O.processing, '5 Rose Street, Bath'), e.addEscalation('c_ava', O.processing, 'x')));
  assert.equal(endStateCheck(spec('end_state', { orderId: O.processing, address: '5 ROSE  street', status: 'processing', escalated: true }), moved).passed, true);
  assert.equal(endStateCheck(spec('end_state', { orderId: O.processing, status: 'cancelled' }), moved).passed, false);
  assert.equal(endStateCheck(spec('end_state', { orderId: O.processing, escalated: false }), moved).passed, false);
});

test('tool_sequence: must call, must not call, order', () => {
  const trace = makeTrace('c_ava', () => {}, { toolCalls: [call('issue_refund'), call('get_order')] });
  assert.equal(toolSequenceCheck(spec('tool_sequence', { mustCall: ['get_order'] }), trace).passed, true);
  assert.equal(toolSequenceCheck(spec('tool_sequence', { mustCall: ['list_orders'] }), trace).passed, false);
  assert.equal(toolSequenceCheck(spec('tool_sequence', { mustNotCall: ['issue_refund'] }), trace).passed, false);
  const order = toolSequenceCheck(spec('tool_sequence', { order: [{ first: 'get_order', then: 'issue_refund' }] }), trace);
  assert.equal(order.passed, false);
  assert.match(order.detail, /issue_refund was called before any call to get_order/);
  assert.equal(toolSequenceCheck(spec('tool_sequence', { order: [{ first: 'get_order', then: 'cancel_order' }] }), trace).passed, true);
});

test('exact_match ignores case', () => {
  const trace = makeTrace('c_ava', () => {}, { output: 'Your refund of $42.00 is on its way.' });
  assert.equal(exactMatchCheck(spec('exact_match', { contains: 'REFUND of $42.00' }), trace).passed, true);
  assert.equal(exactMatchCheck(spec('exact_match', { contains: '$60.00' }), trace).passed, false);
});

test('rubric checks share one model call; a crashed run fails every check', async () => {
  const llm = new ScriptedLlm().pushJson({ results: [{ id: 'r1', detail: 'Says it shipped.', passed: true }, { id: 'r2', detail: 'No date.', passed: false }] });
  const { healer, close } = setupHealer(llm);
  const trace = makeTrace('c_diego', () => {}, { output: 'It shipped!' });
  const results = await evaluateChecks(healer, trace, [
    { id: 'r1', kind: 'rubric', label: 'Shipped', params: { criterion: 'Says it shipped' } },
    spec('exact_match', { contains: 'shipped' }),
    { id: 'r2', kind: 'rubric', label: 'Date', params: { criterion: 'Gives the ship date' } },
  ]);
  assert.deepEqual(results.map((r) => r.passed), [true, true, false]);
  assert.equal(llm.requests.length, 1);
  assert.equal(llm.requests[0]!.role, 'judge');
  assert.match(llm.requests[0]!.messages[0]!.content as string, /\[r1\] Says it shipped\n- \[r2\] Gives the ship date/);
  assert.equal(healer.store.costByRole().byRole[0]!.role, 'judge');

  const crashed = await evaluateChecks(healer, makeTrace('c_ava', () => {}, { error: 'overloaded' }), [spec('exact_match', { contains: 'x' })]);
  assert.equal(crashed[0]!.passed, false);
  assert.match(crashed[0]!.detail, /overloaded/);
  close();
});

test('check specs are validated per kind', () => {
  assert.equal(checkSpecSchema.safeParse({ id: 'a', kind: 'end_state', label: 'l', params: { orderId: 'PM-1', refund: { none: true } } }).success, true);
  assert.equal(checkSpecSchema.safeParse({ id: 'a', kind: 'end_state', label: 'l', params: { refund: { none: true } } }).success, false);
  assert.equal(checkSpecSchema.safeParse({ id: 'a', kind: 'tool_sequence', label: 'l', params: { mustCall: ['fly'] } }).success, false);
  assert.equal(checkSpecSchema.safeParse({ id: 'a', kind: 'rubric', label: 'l', params: {} }).success, false);
  assert.equal(checkSpecSchema.safeParse({ id: 'a', kind: 'consistency', label: 'l', params: {} }).success, false);
});

test('editing a case\'s checks drops its cached results; editing the title does not', async () => {
  const llm = new ScriptedLlm().push({ text: 'Cancelled.' }, { text: 'Cancelled.' });
  const h = setupHealer(llm);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  await h.call('PUT', '/api/healer/settings', { trialsPerCase: 1 });
  for (const c of h.store.evalCases.list()) if (c.id !== 'golden_cancel') await h.call('PATCH', `/api/healer/evals/${c.id}`, { enabled: false });

  const first = await runSuite(h.healer, 0);
  assert.equal(llm.requests.length, 1);
  assert.equal((await runSuite(h.healer, 0)).id, first.id, 'nothing changed, so the run is reused');
  await h.call('PATCH', '/api/healer/evals/golden_cancel', { title: 'Cancel a processing order' });
  assert.equal((await runSuite(h.healer, 0)).id, first.id, 'a new title is not a new test');

  const checks = [{ id: 'cancelled', kind: 'end_state', label: 'PM-1020 is still processing', params: { orderId: 'PM-1020', status: 'processing' } }];
  assert.equal((await h.call('PATCH', '/api/healer/evals/golden_cancel', { checks })).status, 200);
  const second = await runSuite(h.healer, 0);
  assert.notEqual(second.id, first.id);
  assert.equal(llm.requests.length, 2, 'the edited case ran again');
  assert.deepEqual(second.results.map((r) => [r.caseId, r.passed]), [['golden_cancel', true]]);
  assert.equal((await runSuite(h.healer, 0)).id, second.id, 'the fresh result is reused from then on');
  h.close();
});

test('checkConflicts: end_state checks that demand what shop policy forbids', () => {
  const env = seedSnapshot();
  const conflict = (customerId: string, params: Record<string, unknown>) => checkConflicts(spec('end_state', params), env, customerId);
  assert.match(conflict('c_tom', { orderId: O.openedItem, refund: { amount: 66 } })!, /at most \$59\.40 is refundable/);
  assert.match(conflict('c_diego', { orderId: O.openedItem, refund: { amount: 20 } })!, /belongs to another customer/);
  assert.match(conflict('c_diego', { orderId: O.inTransit, refund: { amount: 20 } })!, /has not been delivered/);
  assert.match(conflict('c_marcus', { orderId: O.outsideRefundWindow, refund: { amount: 24 } })!, /52 days before the case starts/);
  assert.match(conflict('c_lena', { orderId: O.alreadyRefunded, refund: { amount: 10 } })!, /already has refund RF-0001/);
  const large = conflict('c_priya', { orderId: O.highValue, refund: { amount: 160 } })!;
  assert.match(large, /above \$150\.00 must go to a human/);
  assert.doesNotMatch(large, /refundable/);
  assert.match(conflict('c_marcus', { orderId: O.storeCredit, refund: { amount: 21, method: 'original_payment' } })!, /paid with store credit, so it must go to store_credit/);
  assert.match(conflict('c_diego', { orderId: O.inTransit, status: 'cancelled' })!, /cancelled on PM-1013, which is shipped, not processing/);
  assert.match(conflict('c_diego', { orderId: O.inTransit, address: '1 New Street' })!, /new shipping address on PM-1013, which is shipped/);
  assert.match(conflict('c_tom', { orderId: 'PM-9999', refund: { none: true } })!, /PM-9999, which is not in the case's records/);

  assert.equal(conflict('c_tom', { orderId: O.openedItem, refund: { amount: 37.4, method: 'original_payment' } }), null, 'a partial refund below the cap');
  assert.equal(conflict('c_ava', { orderId: O.processing, status: 'cancelled', address: '8 Clifton Park Road' }), null);
  assert.equal(conflict('c_marcus', { orderId: O.outsideRefundWindow, refund: { none: true }, escalated: false }), null);
  assert.equal(conflict('c_tom', { orderId: 'PM-1005', status: 'cancelled' }), null, 'an order already cancelled needs nothing done');
  assert.equal(checkConflicts(spec('rubric', { criterion: 'Refund $500' }), env, 'c_tom'), null);
});
