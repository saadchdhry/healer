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
  type GraphShape,
  type Issue,
  type JsonResult,
  type Lineage,
  type LlmClient,
  type LlmContent,
  type LlmRequest,
  type Proposal,
  type Verdict,
} from '@healer/agent';
import type { z } from 'zod';
import { DIAGNOSE_SYSTEM } from './diagnose.ts';
import { JUDGE_SYSTEM } from './judge.ts';
import { makeTrace, setupHealer, waitFor } from './testing.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A stand-in for every model: the agent answers by keyword and follows the notes in its system prompt;
// the judge, diagnosis and proposer answer like the real ones would for a late refund.
class FakeLlm implements LlmClient {
  roles: string[] = [];

  async chat(req: LlmRequest): Promise<ChatResult> {
    this.roles.push(req.role);
    const last = req.messages.at(-1)!;
    let text = '';
    let toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    const tool = (name: string, input: Record<string, unknown>) => (toolUses = [{ id: `toolu_${crypto.randomUUID()}`, name, input }]);
    if (typeof last.content !== 'string') text = 'All done.';
    else if (last.content.includes(O.outsideRefundWindow)) {
      if (req.system.includes('30 days')) text = 'Sorry, that order is outside our 30-day refund window.';
      else tool('issue_refund', { order_id: O.outsideRefundWindow, amount: 49, method: 'original_payment', reason: 'broken' });
    } else if (last.content.includes('watering can')) {
      if (req.system.includes('Never issue refunds')) text = 'Sorry, we do not give refunds.';
      else tool('issue_refund', { order_id: O.cleanRefund, amount: 42, method: 'original_payment', reason: 'leaks' });
    } else if (last.content.includes('cancel order PM-1020 right away')) tool('cancel_order', { order_id: 'PM-1020' });
    else if (last.content.includes('Clifton')) tool('update_shipping_address', { order_id: O.processing, address: '8 Clifton Park Road, Bristol BS8 3HL' });
    else text = 'Hello! How can I help?';
    const content: LlmContent = toolUses.length ? toolUses.map((t) => ({ type: 'tool_use' as const, ...t })) : [{ type: 'text', text }];
    const run = finishModelRun(modelRun(req, req.role, { system: req.system, messages: req.messages }), { content }, req.model, 1000, 50);
    return { stopReason: toolUses.length ? 'tool_use' : 'end_turn', text, toolUses, content, run };
  }

  async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    this.roles.push(req.role);
    const message = req.messages[0]!.content as string;
    let value: unknown;
    if (req.role === 'judge' && req.system === JUDGE_SYSTEM) {
      const ok = { detail: 'Fine.', passed: true };
      value = { truthful: ok, grounded: ok, customer_notes: { applicable: false, detail: 'No notes.', passed: true }, preferences: [] };
    } else if (req.role === 'judge') {
      value = { results: [...message.matchAll(/^- \[(\w+)\]/gm)].map((m) => ({ id: m[1], detail: 'Met.', passed: true })) };
    } else if (req.role === 'diagnose') {
      assert.equal(req.system, DIAGNOSE_SYSTEM);
      value = {
        reasoning: 'Nothing told the agent about the 30-day window.',
        attach_to: null,
        new_issue: { title: 'Refunds issued after the 30-day window', summary: 'Refunds are allowed only within 30 days of delivery.', cause: 'knowledge', scope: 'shop' },
        eval_case: { title: 'Decline a refund 52 days after delivery', checks: [{ kind: 'end_state', label: 'No refund on PM-1002', params: { orderId: O.outsideRefundWindow, refund: { none: true } } }] },
      };
    } else {
      value = { title: 'Add the refund window', rationale: 'The agent did not know it.', changes: [{ op: 'add', text: 'Refunds are allowed only within 30 days of delivery.' }] };
    }
    const parsed = req.schema.parse(value);
    return { value: parsed, run: finishModelRun(modelRun(req, req.role, { system: req.system, messages: req.messages }), parsed, req.model, 2000, 200) };
  }
}

test('end to end: a late refund is judged, diagnosed, fixed, gated, approved and deployed; an over-broad fix is rejected', async () => {
  const llm = new FakeLlm();
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  assert.equal((await h.call<{ trialsPerCase: number }>('PUT', '/api/healer/settings', { trialsPerCase: 1 })).body.trialsPerCase, 1);

  const shopTrace = makeTrace('c_marcus', (e) => e.addRefund(O.outsideRefundWindow, 49, 'original_payment', 'broken'), {
    input: `The shears from ${O.outsideRefundWindow} broke. Refund please.`,
    output: 'I have refunded $49.00.',
    toolCalls: [{ runId: 'r', name: 'issue_refund', input: { order_id: O.outsideRefundWindow, amount: 49 }, output: {}, blockedByGuard: null }],
  });
  h.shop.publish({ type: 'trace.completed', trace: shopTrace });
  await waitFor(() => h.store.proposals.list().some((p) => p.status === 'awaiting_approval'), 10_000);

  const verdict = (await h.call<{ verdict: Verdict }>('GET', `/api/healer/traces/${shopTrace.id}`)).body.verdict;
  assert.equal(verdict.passed, false);
  assert.match(verdict.checks.find((c) => c.checkId === 'policy:refund_window')!.detail, /52 days ago/);
  const [issue] = (await h.call<Issue[]>('GET', '/api/healer/issues')).body;
  assert.deepEqual([issue!.cause, issue!.surface, issue!.scope.kind, issue!.status], ['knowledge', 'context', 'shop', 'proposed']);
  const failureCase = h.store.evalCases.get(issue!.evalCaseIds[0]!)!;
  assert.deepEqual(failureCase.checks.map((c) => c.kind), ['invariant', 'end_state']);
  assert.equal(failureCase.origin, 'failure');
  assert.equal(failureCase.env.refunds.length, 1, 'the case starts from the records before the bad refund');

  const [proposal] = (await h.call<Proposal[]>('GET', '/api/healer/proposals')).body;
  const gate = h.store.gateRuns.get(proposal!.gateRunId!)!;
  assert.equal(gate.decision, 'accept');
  assert.deepEqual(gate.fixedCaseIds, [failureCase.id]);
  assert.deepEqual(gate.regressedCaseIds, []);
  assert.equal(h.store.evalRuns.get(gate.baseRunId!)!.results.length, 7);

  const approved = await h.call<AgentVersion>('POST', `/api/healer/proposals/${proposal!.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(h.shop.deployed.id, proposal!.candidateVersionId);
  assert.match(h.shop.deployed.context[0]!.text, /30 days of delivery/);
  assert.equal(h.store.issues.get(issue!.id)!.status, 'fixed');
  assert.deepEqual(h.store.versions.list().map((v) => v.status), ['superseded', 'live']);
  assert.equal((await h.call('POST', `/api/healer/proposals/${proposal!.id}/approve`)).status, 409);

  const lineage = (await h.call<Lineage>('GET', `/api/healer/lineage?kind=trace&id=${shopTrace.id}`)).body;
  assert.deepEqual(
    [lineage.traces.length, lineage.verdicts.length, lineage.issues.length, lineage.proposals.length, lineage.gateRuns.length, lineage.evalCases.length],
    [1, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(lineage.versions.map((v) => v.id).sort(), ['0', String(proposal!.candidateVersionId)]);
  const fromVersion = (await h.call<Lineage>('GET', `/api/healer/lineage?kind=version&id=${proposal!.candidateVersionId}`)).body;
  assert.equal(fromVersion.traces[0]!.id, shopTrace.id);

  // The over-broad fix: the failure case still passes, but the clean refund regresses.
  const human = await h.call<Proposal>('POST', '/api/healer/proposals', {
    title: 'Stop all refunds',
    rationale: 'Refunds keep going wrong.',
    changes: [{ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: 'Never issue refunds under any circumstances.' }],
  });
  assert.equal(human.status, 200);
  assert.equal((await h.call('POST', `/api/healer/proposals/${human.body.id}/gate`)).status, 200);
  await waitFor(() => h.store.proposals.get(human.body.id)!.status === 'rejected', 10_000);
  const rejected = h.store.gateRuns.get(h.store.proposals.get(human.body.id)!.gateRunId!) as GateRun;
  assert.deepEqual(rejected.regressedCaseIds, ['golden_clean_refund']);
  assert.match(rejected.reasons[0]!, /^Rejected/);
  assert.equal(h.store.versions.get(human.body.candidateVersionId)!.status, 'rejected');
  // The base version's suite run was reused, not repeated.
  assert.equal(h.store.evalRuns.list().filter((r) => r.versionId === proposal!.candidateVersionId).length, 1);

  const jobs = h.store.jobs.list();
  assert.ok(jobs.every((j) => j.status === 'done'));
  assert.equal(jobs.find((j) => j.kind === 'gate' && j.label.includes(human.body.id))!.refId, human.body.id);

  const costs = h.store.costByRole().byRole.map((r) => r.role);
  assert.deepEqual(costs, ['agent', 'diagnose', 'judge', 'propose']);

  const graphs = (await h.call<{ loop: GraphShape; agent: GraphShape }>('GET', '/api/healer/graphs')).body;
  assert.deepEqual(graphs.loop.nodes.map((n) => n.id), ['judge', 'diagnose', 'propose', 'gate', 'promote']);
  assert.equal(graphs.agent.entry, 'route');
  assert.equal((await h.call('POST', '/api/healer/simulate', { count: 2 })).status, 501);
  assert.equal((await h.call<{ error: string }>('GET', '/api/healer/nope')).body.error, 'not_found');

  // Reset to factory: golden cases and version 0 only.
  assert.equal((await h.call('POST', '/api/healer/reset')).status, 200);
  assert.equal(h.shop.resets, 1);
  assert.ok(h.store.evalCases.list().every((c: EvalCase) => c.origin === 'golden'));
  assert.deepEqual(h.store.versions.list().map((v) => v.id), [0]);
  assert.equal(h.store.issues.count() + h.store.proposals.count() + h.store.traceCount(), 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.store.versions.count(), 1, 'the shop reset event is not ingested twice');
  h.close();
});

test('manual autonomy stops after the judge; a thumbs-down re-judges with a failed feedback check', async () => {
  const llm = new FakeLlm();
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  await h.call('PUT', '/api/healer/settings', { autonomy: 'manual' });

  const late = makeTrace('c_marcus', (e) => e.addRefund(O.outsideRefundWindow, 49, 'original_payment', 'r'));
  const fine = makeTrace('c_tom', () => {}, { input: 'Hi there!', output: 'Hello!' });
  h.shop.publish({ type: 'trace.completed', trace: late });
  h.shop.publish({ type: 'trace.completed', trace: fine });
  await waitFor(() => Boolean(h.store.verdictForTrace(fine.id)));
  assert.equal(h.store.verdictForTrace(late.id)!.passed, false);
  assert.equal(h.store.verdictForTrace(fine.id)!.passed, true);
  assert.equal(h.store.issues.count(), 0, 'manual mode does not diagnose');

  h.shop.publish({ type: 'feedback', traceId: fine.id, rating: 'down' });
  await waitFor(() => h.store.verdictForTrace(fine.id)!.passed === false);
  const feedback = h.store.verdictForTrace(fine.id)!.checks.find((c) => c.kind === 'feedback')!;
  assert.equal(feedback.passed, false);

  // Every later step runs through its route.
  const job = await h.call<{ id: string; refId: string | null }>('POST', '/api/healer/diagnose');
  assert.equal(job.body.refId, null);
  await waitFor(() => h.store.jobs.get(job.body.id)!.status !== 'running');
  assert.equal(h.store.jobs.get(job.body.id)!.status, 'done');
  assert.equal(h.store.issues.count(), 2);
  assert.equal(h.store.proposals.count(), 0);
  h.close();
});

test('a fix the gate keeps rejecting is retried twice, then the loop moves on', async () => {
  class OverBroad extends FakeLlm {
    override async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
      if (req.role !== 'propose') return super.json(req);
      const value = req.schema.parse({ title: 'Stop refunds', rationale: 'Safer.', changes: [{ op: 'add', text: 'Never issue refunds under any circumstances.' }] });
      return { value, run: finishModelRun(modelRun(req, req.role, {}), value, req.model, 10, 10) };
    }
  }
  const h = setupHealer(new OverBroad());
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  await h.call('PUT', '/api/healer/settings', { trialsPerCase: 1 });
  h.shop.publish({ type: 'trace.completed', trace: makeTrace('c_marcus', (e) => e.addRefund(O.outsideRefundWindow, 49, 'original_payment', 'r')) });
  await waitFor(() => h.store.proposals.count() === 3 && h.store.proposals.list().every((p) => p.status === 'rejected'), 10_000);
  await h.healer.enqueue(async () => {});
  const issue = h.store.issues.list()[0]!;
  assert.equal(issue.status, 'open');
  assert.equal(issue.proposalIds.length, 3);
  assert.ok(!h.store.activity.list().some((a) => a.text.includes('loop stopped')));
  const retryPrompt = h.store.proposals.list()[2]!;
  assert.equal(retryPrompt.proposeRun?.role, 'propose');
  h.close();
});
