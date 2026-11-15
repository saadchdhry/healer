import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import {
  finishModelRun,
  modelRun,
  NOTABLE_ORDERS as O,
  type AgentVersion,
  type ChatResult,
  type EvalCase,
  type GateRun,
  type Issue,
  type Job,
  type JsonResult,
  type LlmClient,
  type LlmContent,
  type LlmRequest,
  type Proposal,
  type RouterExample,
  type RouterModel,
  type ToolCallRecord,
  type ToolName,
} from '@healer/agent';
import type { z } from 'zod';
import { assignSplits, labelRequest, sourceTraces, wrongness } from './routerTraining.ts';
import { makeTrace, setupHealer, waitFor } from './testing.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CLEAN = 'PM-1012';
const refund = (order_id: string, amount: number, method = 'original_payment') => ({ name: 'issue_refund', input: { order_id, amount, method, reason: 'r' } });

// Per message keyword, what each tier does. Sonnet is the reference: it refunds the clean order in full.
// "late": haiku refunds an order outside the window (a policy rule breaks). "under": haiku refunds too little.
// "flaky": one haiku replay in four refunds too little. "ask": haiku asks a question where sonnet acts.
class TierLlm implements LlmClient {
  private flaky = 0;

  async chat(req: LlmRequest): Promise<ChatResult> {
    const last = req.messages.at(-1)!;
    const text = typeof last.content === 'string' ? last.content : null;
    const haiku = req.model.includes('haiku');
    let use: { name: string; input: Record<string, unknown> } | null = null;
    if (text?.includes('late') && haiku) use = refund(O.outsideRefundWindow, 24);
    else if (text && /under|flaky|ask/.test(text)) {
      if (!haiku) use = refund(CLEAN, 52);
      else if (text.includes('under')) use = refund(CLEAN, 40);
      else if (text.includes('flaky')) use = this.flaky++ % 4 === 0 ? refund(CLEAN, 40) : refund(CLEAN, 52);
    }
    const toolUses = use ? [{ id: `toolu_${crypto.randomUUID()}`, ...use }] : [];
    const reply = use ? '' : text?.includes('ask') ? 'Which item would you like refunded?' : 'All sorted.';
    const content: LlmContent = toolUses.length ? toolUses.map((t) => ({ type: 'tool_use' as const, ...t })) : [{ type: 'text', text: reply }];
    const run = finishModelRun(modelRun(req, req.role, {}), { content }, req.model, 1000, 100);
    return { stopReason: toolUses.length ? 'tool_use' : 'end_turn', text: reply, toolUses, content, run };
  }

  async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    const message = req.messages[0]!.content as string;
    const parsed = req.schema.parse({ results: [...message.matchAll(/^- \[(\w+)\]/gm)].map((m) => ({ id: m[1], detail: 'Met.', passed: true })) });
    return { value: parsed, run: finishModelRun(modelRun(req, req.role, {}), parsed, req.model, 100, 10) };
  }
}

async function healer(llm: LlmClient = new TierLlm()) {
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  await h.call('PUT', '/api/healer/settings', { trialsPerCase: 1 });
  return h;
}

async function buildDataset(h: Awaited<ReturnType<typeof healer>>, maxExamples: number): Promise<RouterExample[]> {
  const job = (await h.call<Job>('POST', '/api/healer/model/router/dataset', { maxExamples })).body;
  await waitFor(() => h.store.jobs.get(job.id)!.status !== 'running', 10_000);
  assert.equal(h.store.jobs.get(job.id)!.status, 'done');
  return h.store.routerDataset();
}

test('wrongness: policy, disagreement with a reference that kept the rules, and asking is not wrong', () => {
  const t = (act: Parameters<typeof makeTrace>[1]) => makeTrace('c_marcus', act);
  const full = t((e) => e.addRefund(CLEAN, 52, 'original_payment', 'r'));
  assert.match(wrongness(t((e) => e.addRefund(O.outsideRefundWindow, 24, 'original_payment', 'r')), full)!, /^broke a policy rule \(Refunds only within 30 days/);
  assert.equal(wrongness(t(() => {}), full), null, 'asking where the reference acted');
  assert.equal(wrongness(t((e) => e.addRefund(CLEAN, 52.004, 'original_payment', 'r')), full), null);
  assert.equal(wrongness(t((e) => e.addRefund(CLEAN, 40, 'original_payment', 'r')), full), 'refunded $40.00 to original_payment where the reference refunded $52.00 to original_payment');
  assert.match(wrongness(t((e) => e.addRefund(CLEAN, 52, 'store_credit', 'r')), full)!, /Refund to the way the order was paid/);
  assert.equal(wrongness(t((e) => e.addEscalation('c_marcus', CLEAN, 'x')), full), `made a escalation about ${CLEAN} that the reference did not make`);
  const badReference = t((e) => e.addRefund(O.outsideRefundWindow, 24, 'original_payment', 'r'));
  assert.equal(wrongness(t((e) => e.addRefund(CLEAN, 40, 'original_payment', 'r')), badReference), null, 'a reference that broke a rule is no reference');
  assert.equal(wrongness(makeTrace('c_marcus', (e) => e.addRefund(CLEAN, 1, 'original_payment', 'r'), { error: 'overloaded' }), full), null);
});

test('wrongness: a refund one cent from the reference is not wrong, two cents is', () => {
  const t = (amount: number) => makeTrace('c_marcus', (e) => e.addRefund(CLEAN, amount, 'original_payment', 'r'));
  assert.equal(wrongness(t(40.01), t(40.02)), null);
  assert.equal(wrongness(t(40), t(40.02)), 'refunded $40.00 to original_payment where the reference refunded $40.02 to original_payment');
});

test('labelling by risk: refunds and cancellations attempted in any replay, blocked or not; measured failure wins', () => {
  const call = (name: ToolName, blockedByGuard: ToolCallRecord['blockedByGuard'] = null): ToolCallRecord => ({ runId: 'run', name, input: {}, output: {}, blockedByGuard });
  const t = (calls: ToolCallRecord[] = [], act: Parameters<typeof makeTrace>[1] = () => {}) => makeTrace('c_marcus', act, { toolCalls: calls });
  const lookup = () => t([call('get_order')]);
  const easyOnly = (...calls: ToolCallRecord[]) => labelRequest(lookup(), [lookup(), t(calls), lookup(), lookup()]);

  const refundedByReference = labelRequest(t([call('get_order'), call('issue_refund')]), [lookup(), lookup(), lookup(), lookup()]);
  assert.deepEqual([refundedByReference.reason, refundedByReference.easyPassed, refundedByReference.hardPassed], ['high_stakes', true, true], 'an attempted refund');
  const cancelled = easyOnly(call('cancel_order'));
  assert.equal(cancelled.reason, 'high_stakes', 'an attempted cancellation');
  assert.equal(cancelled.shown.toolCalls[0]!.name, 'cancel_order', 'the dataset links to the replay that took the risk');
  assert.equal(easyOnly(call('issue_refund', 'requireOrderLookupBeforeWrite')).reason, 'high_stakes', 'a call a guard blocked');
  assert.equal(easyOnly(call('update_shipping_address')).reason, null, 'an address change can be undone');
  assert.equal(easyOnly(call('escalate_to_human')).reason, null, 'an escalation hands over to a person');
  assert.equal(labelRequest(lookup(), [lookup(), lookup(), lookup(), lookup()]).reason, null, 'a lookup stays on the small model');

  const fullRefund = t([call('issue_refund')], (e) => e.addRefund(CLEAN, 52, 'original_payment', 'r'));
  const underRefund = t([call('issue_refund')], (e) => e.addRefund(CLEAN, 40, 'original_payment', 'r'));
  const both = labelRequest(fullRefund, [fullRefund, underRefund, fullRefund, fullRefund]);
  assert.deepEqual([both.reason, both.easyPassed, both.shown], ['measured_failure', false, underRefund], 'both reasons apply');

  const lateRefund = t([call('issue_refund')], (e) => e.addRefund(O.outsideRefundWindow, 24, 'original_payment', 'r'));
  const badReference = labelRequest(lateRefund, [underRefund, lookup(), lookup(), lookup()]);
  assert.deepEqual([badReference.reason, badReference.hardPassed], ['high_stakes', false], 'high stakes does not need the reference to pass');
});

test('splits are deterministic and stratified', () => {
  const ex = (i: number, needsStrong: boolean) => ({ id: `x${i}`, text: `request ${i}`, needsStrong, reason: needsStrong ? ('high_stakes' as const) : null, easyTraceId: '', hardTraceId: '', easyPassed: !needsStrong, hardPassed: true });
  const examples = [...Array.from({ length: 8 }, (_, i) => ex(i, true)), ...Array.from({ length: 12 }, (_, i) => ex(i + 8, false))];
  const a = assignSplits(examples);
  assert.deepEqual(a, assignSplits([...examples].reverse()).reverse());
  assert.equal(a.filter((e) => e.needsStrong && e.split === 'val').length, 2);
  assert.equal(a.filter((e) => !e.needsStrong && e.split === 'val').length, 3);
  assert.ok(assignSplits(examples.slice(5)).filter((e) => e.needsStrong).every((e) => e.split === 'train'), 'too few positives: all train');
});

test('a size cut keeps every seeded message, then the newest others', async () => {
  const h = await healer();
  for (const i of [1, 2, 3]) h.store.saveTrace(makeTrace('c_marcus', () => {}, { input: `seed ${i}`, source: 'seed' }));
  for (const i of [1, 2, 3, 4, 5]) h.store.saveTrace(makeTrace('c_marcus', () => {}, { input: `sim ${i}`, source: 'simulator' }));
  assert.deepEqual(sourceTraces(h.healer, 4).map((t) => t.input), ['seed 3', 'seed 2', 'seed 1', 'sim 5']);
  h.close();
});

test('dataset by repeated replays, honest metrics, routed proposal through the gate, then the tier picker', async () => {
  const texts = [
    ...[0, 1, 2, 3].map((i) => `refund my late order please, case ${i}`),
    ...[0, 1, 2].map((i) => `under refund the planters, case ${i}`),
    'flaky refund the planters',
    ...[0, 1, 2, 3].map((i) => `ask about refunding the planters, case ${i}`),
    ...Array.from({ length: 8 }, (_, i) => `where is my parcel, case ${i}`),
  ];
  const h = await healer();
  for (const input of [...texts, texts[0]!]) h.store.saveTrace(makeTrace('c_marcus', () => {}, { input, source: 'shop' }));
  h.store.saveTrace(makeTrace('c_marcus', () => {}, { input: 'a follow-up', history: [{ role: 'customer', text: 'hi' }, { role: 'agent', text: 'hello' }] }));

  const dataset = await buildDataset(h, 50);
  assert.equal(dataset.length, 20, 'distinct first messages only');
  for (const e of dataset) {
    const failed = /late|under|flaky/.test(e.text);
    const reason = failed ? 'measured_failure' : e.text.startsWith('ask') ? 'high_stakes' : null;
    assert.deepEqual([e.reason, e.needsStrong], [reason, reason !== null], e.text);
    assert.deepEqual([e.easyPassed, e.hardPassed], [!failed, true], e.text);
    assert.equal(h.store.trace(e.hardTraceId)!.tierUsed, 'sonnet');
    assert.equal(h.store.trace(e.easyTraceId)!.source, 'replay');
  }
  const flaky = dataset.find((e) => e.text.startsWith('flaky'))!;
  assert.equal(h.store.trace(flaky.easyTraceId)!.toolCalls[0]!.input.amount, 40, 'easyTraceId points at the wrong replay');
  assert.equal(h.store.traceSummaries({ source: 'replay' }).length, 100, '4 easy and 1 hard replay per example');
  assert.equal(h.store.verdicts().length, 0, 'no model judge for replays');
  assert.match(h.store.activity.list().at(-1)!.text, /20 requests, 100 replays \(4 on haiku and 1 on sonnet each\), labelled by risk in code, no model judge; 12 carry risk and go to sonnet \(4 attempted a refund or cancellation, 8 failed on haiku where sonnet kept every rule\)$/);

  const trained = await h.call<RouterModel>('POST', '/api/healer/model/router/train');
  assert.equal(trained.status, 200);
  const m = trained.body.metrics;
  assert.deepEqual([m.trainSize, m.trainPositives, m.valSize, m.valPositives], [15, 9, 5, 3]);
  assert.equal(typeof m.valRecall, 'number');
  const strongest = trained.body.vocabulary.map((w, i) => ({ w, v: trained.body.weights[i]! })).sort((a, b) => b.v - a.v);
  assert.ok(strongest.slice(0, 3).some((p) => p.w === 'refund'), strongest.slice(0, 5).map((p) => p.w).join(', '));

  // A capability issue whose case the router must send to sonnet.
  const issue: Issue = {
    id: 'iss_cap', kind: 'failure', createdAt: '', updatedAt: '', title: 'Late refunds miscounted', summary: '', cause: 'capability', surface: 'model', scope: { kind: 'shop' },
    status: 'fixed', traceIds: [], evalCaseIds: ['ev_cap'], proposalIds: [], diagnoseRun: null,
  };
  h.store.issues.put(issue);
  const capCase: EvalCase = { ...h.store.evalCases.get('golden_greeting')!, id: 'ev_cap', title: 'Late refund', origin: 'failure', issueId: 'iss_cap', message: texts[0]! };
  h.store.evalCases.put(capCase);

  const proposal = (await h.call<Proposal>('POST', `/api/healer/model/router/${trained.body.id}/propose`)).body;
  assert.deepEqual([proposal.author, proposal.issueId], ['loop', null]);
  assert.match(proposal.rationale, /It learns which requests carry risk and sends those to sonnet, while lookups and questions stay on haiku\..*Of the 3 held-out requests that carry risk, it routes \d+% to sonnet\./);
  const candidate = h.store.versions.get(proposal.candidateVersionId)!;
  assert.deepEqual({ ...candidate.model, router: undefined }, { mode: 'routed', easyTier: 'haiku', hardTier: 'sonnet', effort: 'low', router: undefined });

  await h.call('POST', `/api/healer/proposals/${proposal.id}/gate`);
  await waitFor(() => !['draft', 'gating'].includes(h.store.proposals.get(proposal.id)!.status), 10_000);
  const gate = h.store.gateRuns.get(h.store.proposals.get(proposal.id)!.gateRunId!) as GateRun;
  assert.equal(gate.decision, 'accept', gate.reasons.join('\n'));
  assert.match(gate.reasons[0]!, /^Accepted: cost per task goes from \$\d\.\d{4} on version 0 to \$\d\.\d{4} on version 1/);
  assert.ok(gate.reasons.some((r) => /^Routing: all 1 capability case goes to sonnet \(router score 0\.\d\d\)\.$/.test(r)));
  assert.ok(gate.reasons.some((r) => /^Routing share: of the 20 requests in the router dataset, it sends \d+ \(\d+%\) to sonnet and the other \d+ to haiku\.$/.test(r)));

  const live = await h.call<AgentVersion>('POST', `/api/healer/proposals/${proposal.id}/approve`);
  assert.equal(h.shop.deployed.model.mode, 'routed');
  const picked = await h.call<AgentVersion>('POST', '/api/healer/model/tier', { tier: 'opus' });
  assert.deepEqual(picked.body.model, { mode: 'fixed', tier: 'opus', effort: 'low' });
  assert.equal(picked.body.parentId, live.body.id);
  h.close();
});

test('training without any request that carries risk is a conflict; a router with no held-out positives says so', async () => {
  const h = await healer();
  for (const input of ['where is my parcel', 'hello there', 'what time do you open']) h.store.saveTrace(makeTrace('c_marcus', () => {}, { input }));
  assert.equal((await h.call('POST', '/api/healer/model/router/train')).status, 409);
  assert.deepEqual((await buildDataset(h, 10)).map((e) => e.needsStrong), [false, false, false]);
  const res = await h.call<{ error: string; message: string }>('POST', '/api/healer/model/router/train');
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'conflict');
  assert.match(res.body.message, /no requests that carry risk yet/);
  assert.equal((await h.call('POST', '/api/healer/model/router/nope/propose')).status, 404);

  h.store.setRouterDataset(h.store.routerDataset().map((e, i) => ({ ...e, needsStrong: i === 0, split: 'train' })));
  const trained = (await h.call<RouterModel>('POST', '/api/healer/model/router/train')).body;
  assert.equal(trained.metrics.valRecall, null);
  const proposal = (await h.call<Proposal>('POST', `/api/healer/model/router/${trained.id}/propose`)).body;
  assert.match(proposal.rationale, /None of the held-out requests carry risk, so the held-out accuracy says nothing/);
  h.close();
});
