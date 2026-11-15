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
  factoryVersion,
} from '@healer/agent';
import type { z } from 'zod';
import { DIAGNOSE_SYSTEM, REDIAGNOSE_SYSTEM, quoteInVersion, undiagnosed } from './diagnose.ts';
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
      value = { truthful: ok, grounded: ok, customer_notes: { applicable: false, detail: 'No notes.', passed: true }, refund_request: null, preferences: [] };
    } else if (req.role === 'judge') {
      value = { results: [...message.matchAll(/^- \[(\w+)\]/gm)].map((m) => ({ id: m[1], detail: 'Met.', passed: true })) };
    } else if (req.role === 'diagnose') {
      assert.equal(req.system, DIAGNOSE_SYSTEM);
      value = {
        reasoning: 'Nothing told the agent about the 30-day window.',
        covering_quote: null,
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
  assert.equal((await h.call('POST', '/api/healer/simulate', { count: 0 })).status, 400);
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

// Answers the judge with one customer preference whenever the message carries "call me Marc".
class PreferenceJudge extends FakeLlm {
  override async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    const message = req.messages[0]!.content as string;
    if (req.role !== 'judge' || req.system !== JUDGE_SYSTEM || !message.includes('call me Marc')) return super.json(req);
    const ok = { detail: 'Fine.', passed: true };
    const value = req.schema.parse({
      truthful: ok,
      grounded: ok,
      customer_notes: { applicable: false, detail: 'No notes.', passed: true },
      refund_request: null,
      preferences: [{ said: 'call me Marc', note: 'Prefers to be called Marc.' }],
    });
    return { value, run: finishModelRun(modelRun(req, req.role, {}), value, req.model, 10, 10) };
  }
}

async function started(llm: LlmClient) {
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  await h.call('PUT', '/api/healer/settings', { trialsPerCase: 1 });
  return h;
}

const idle = (h: { healer: { enqueue: (fn: () => Promise<void>) => Promise<void> } }) => h.healer.enqueue(async () => {});

test('a failed verdict that also states a preference is diagnosed first, then the preference gets its own proposal; approving one re-proposes the other', async () => {
  const h = await started(new PreferenceJudge());
  const trace = makeTrace('c_marcus', (e) => e.addRefund(O.outsideRefundWindow, 49, 'original_payment', 'broken'), {
    input: `Please call me Marc from now on. The shears from ${O.outsideRefundWindow} broke, refund please.`,
  });
  h.shop.publish({ type: 'trace.completed', trace });
  await waitFor(() => h.store.proposals.list().filter((p) => p.status === 'awaiting_approval').length === 2, 10_000);
  await idle(h);

  const issues = h.store.issues.list();
  const failure = issues.find((i) => i.kind === 'failure')!;
  const preference = issues.find((i) => i.kind === 'preference')!;
  assert.deepEqual([failure.scope.kind, failure.evalCaseIds.length, failure.traceIds], ['shop', 1, [trace.id]]);
  assert.deepEqual([preference.scope, preference.evalCaseIds.length, preference.traceIds], [{ kind: 'customer', customerId: 'c_marcus' }, 0, [trace.id]]);
  assert.deepEqual(undiagnosed(h.healer), []);
  const [first, second] = h.store.proposals.list();
  assert.deepEqual([first!.issueId, second!.issueId], [failure.id, preference.id], 'the failure is proposed for before the preference');

  // Approving the failure's fix leaves the preference's proposal on a replaced version: it is rebuilt on the new live version and gated again.
  assert.equal((await h.call('POST', `/api/healer/proposals/${first!.id}/approve`)).status, 200);
  assert.equal(h.store.proposals.get(second!.id)!.status, 'discarded');
  await waitFor(() => h.store.proposals.count() === 3 && h.store.proposals.list()[2]!.status === 'awaiting_approval', 10_000);
  await idle(h);
  const again = h.store.proposals.list()[2]!;
  assert.deepEqual([again.issueId, again.title, again.changes, again.baseVersionId], [preference.id, second!.title, second!.changes, first!.candidateVersionId]);
  assert.equal(h.store.issues.get(preference.id)!.status, 'proposed');
  assert.ok(h.store.activity.list().some((a) => a.text.startsWith(`Proposed again on version ${first!.candidateVersionId}, which replaced version 0`)));
  assert.equal(h.store.proposals.count(), 3, 'the re-gated proposal waits; nothing is re-proposed twice');
  h.close();
});

test('a waiting proposal whose changes no longer apply is discarded with the reason when another is promoted', async () => {
  const h = await started(new FakeLlm());
  await h.call('PUT', '/api/healer/settings', { autonomy: 'manual' });
  const add = await h.call<Proposal>('POST', '/api/healer/proposals', {
    title: 'Add a note',
    rationale: 'r',
    changes: [{ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: 'Refunds are allowed only within 30 days of delivery.' }],
  });
  await h.call('POST', `/api/healer/proposals/${add.body.id}/gate`);
  await waitFor(() => h.store.proposals.get(add.body.id)!.status === 'awaiting_approval', 10_000);
  assert.equal((await h.call('POST', `/api/healer/proposals/${add.body.id}/approve`)).status, 200);
  const noteId = h.store.liveVersion()!.context[0]!.id;
  const edit = await h.call<Proposal>('POST', '/api/healer/proposals', { title: 'Edit the note', rationale: 'r', changes: [{ surface: 'context', op: 'edit', noteId, text: 'Refunds within 30 days.' }] });
  const remove = await h.call<Proposal>('POST', '/api/healer/proposals', { title: 'Remove the note', rationale: 'r', changes: [{ surface: 'context', op: 'remove', noteId }] });
  await h.call('POST', `/api/healer/proposals/${remove.body.id}/gate`);
  await waitFor(() => h.store.proposals.get(remove.body.id)!.status !== 'gating' && h.store.proposals.get(remove.body.id)!.gateRunId !== null, 10_000);
  await idle(h);
  // Promote the removal by hand regardless of its gate: the edit then targets a note that is gone.
  h.store.proposals.put({ ...h.store.proposals.get(remove.body.id)!, status: 'awaiting_approval' });
  assert.equal((await h.call('POST', `/api/healer/proposals/${remove.body.id}/approve`)).status, 200);
  assert.equal(h.store.proposals.get(edit.body.id)!.status, 'discarded');
  assert.equal(h.store.proposals.count(), 3, 'nothing new was drafted');
  assert.ok(h.store.activity.list().some((a) => a.text.includes('Discarded proposal: Edit the note: it no longer applies') && a.text.includes(noteId)));
  h.close();
});

test('a rejected proposal can be proposed again; only a draft can be gated', async () => {
  const h = await started(new FakeLlm());
  await h.call('PUT', '/api/healer/settings', { autonomy: 'manual' });
  const bad = await h.call<Proposal>('POST', '/api/healer/proposals', {
    title: 'Stop all refunds',
    rationale: 'Refunds keep going wrong.',
    changes: [{ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: 'Never issue refunds under any circumstances.' }],
  });
  await h.call('POST', `/api/healer/proposals/${bad.body.id}/gate`);
  await waitFor(() => h.store.proposals.get(bad.body.id)!.status === 'rejected', 10_000);
  assert.equal((await h.call('POST', `/api/healer/proposals/${bad.body.id}/gate`)).status, 409);

  const again = await h.call<Proposal>('POST', `/api/healer/proposals/${bad.body.id}/again`);
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.status, again.body.title, again.body.changes, again.body.baseVersionId], ['draft', 'Stop all refunds', bad.body.changes, 0]);
  assert.notEqual(again.body.candidateVersionId, bad.body.candidateVersionId);
  assert.equal((await h.call('POST', `/api/healer/proposals/${again.body.id}/again`)).status, 409, 'a draft is not proposed again');
  assert.equal((await h.call('POST', `/api/healer/proposals/${again.body.id}/gate`)).status, 200);

  const gone = { ...bad.body, id: 'prop_gone', status: 'rejected' as const, changes: [{ surface: 'context' as const, op: 'remove' as const, noteId: 'note_gone' }] };
  h.store.proposals.put(gone);
  const refused = await h.call<{ message: string }>('POST', '/api/healer/proposals/prop_gone/again');
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /no longer apply to live version 0: there is no context note note_gone/);
  await idle(h);
  h.close();
});

test('running the suite by hand always runs fresh; the gate still reuses', async () => {
  const h = await started(new FakeLlm());
  for (let i = 0; i < 2; i++) {
    const job = await h.call<{ id: string }>('POST', '/api/healer/evals/run', { versionId: 0 });
    await waitFor(() => h.store.jobs.get(job.body.id)!.status !== 'running', 10_000);
  }
  const runs = h.store.evalRuns.list().filter((r) => r.versionId === 0);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === 'done' && r.results.length === 6 && r.results.every((x) => x.trials.length === 1)));
  assert.notEqual(runs[0]!.results[0]!.trials[0]!.traceId, runs[1]!.results[0]!.trials[0]!.traceId);
  h.close();
});

const FACTORY_QUOTE = 'Use your tools to look things up and to take actions for the customer.';

test('a capability diagnosis must quote the live version', () => {
  const v = factoryVersion();
  assert.equal(quoteInVersion(v, FACTORY_QUOTE), true);
  assert.equal(quoteInVersion(v, `"${FACTORY_QUOTE.replaceAll(' ', '  ')}"`), true, 'surrounding quotes and spacing do not matter');
  assert.equal(quoteInVersion(v, 'Refunds are allowed only within 30 days of delivery.'), false);
  assert.equal(quoteInVersion(v, null), false);
  assert.equal(quoteInVersion({ ...v, context: [{ id: 'n', scope: { kind: 'shop' }, text: 'Refunds are allowed only within 30 days of delivery.', addedInVersion: 1, issueId: null }] }, 'only within 30 days'), true);
});

// Diagnosis that calls the late refund a capability gap, quoting `quote`; asked again, it finds a knowledge gap.
class CapabilityDiagnosis extends FakeLlm {
  constructor(private quote: string | null) {
    super();
  }
  override async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    if (req.role !== 'diagnose') return super.json(req);
    this.roles.push(req.system === REDIAGNOSE_SYSTEM ? 'rediagnose' : 'diagnose');
    const value = req.schema.parse(
      req.system === REDIAGNOSE_SYSTEM
        ? { reasoning: 'Sonnet failed too, and no note states the window.', cause: 'knowledge', scope: 'shop', covering_quote: null }
        : {
            reasoning: 'The agent should have known better.',
            covering_quote: this.quote,
            attach_to: null,
            new_issue: { title: 'Refunds issued after the 30-day window', summary: 'Refunds are allowed only within 30 days.', cause: 'capability', scope: 'shop' },
            eval_case: { title: 'No late refund', checks: [{ kind: 'end_state', label: 'No refund on PM-1002', params: { orderId: O.outsideRefundWindow, refund: { none: true } } }] },
          },
    );
    return { value, run: finishModelRun(modelRun(req, req.role, {}), value, req.model, 10, 10) };
  }
}

test('a capability diagnosis whose quote is not in the live version is filed as a knowledge gap', async () => {
  const h = await started(new CapabilityDiagnosis('Refunds are allowed only within 30 days of delivery.'));
  await h.call('PUT', '/api/healer/settings', { autonomy: 'manual' });
  h.shop.publish({ type: 'trace.completed', trace: makeTrace('c_marcus', (e) => e.addRefund(O.outsideRefundWindow, 49, 'original_payment', 'r')) });
  await waitFor(() => h.store.verdicts({}).length === 1);
  const job = await h.call<{ id: string }>('POST', '/api/healer/diagnose');
  await waitFor(() => h.store.jobs.get(job.body.id)!.status !== 'running');
  const [issue] = h.store.issues.list();
  assert.deepEqual([issue!.cause, issue!.surface, issue!.scope.kind], ['knowledge', 'context', 'shop']);
  assert.ok(h.store.activity.list().some((a) => a.text.includes('its quote does not appear in version 0')));
  h.close();
});

test('when a stronger model is rejected because the issue case still fails, the issue is diagnosed again and the loop follows the new cause', async () => {
  const llm = new CapabilityDiagnosis(FACTORY_QUOTE);
  const h = await started(llm);
  h.shop.publish({ type: 'trace.completed', trace: makeTrace('c_marcus', (e) => e.addRefund(O.outsideRefundWindow, 49, 'original_payment', 'r'), { input: `The shears from ${O.outsideRefundWindow} broke. Refund please.` }) });
  await waitFor(() => h.store.proposals.list().some((p) => p.status === 'awaiting_approval'), 10_000);
  await idle(h);
  const [issue] = h.store.issues.list();
  const [model, note] = h.store.proposals.list();
  assert.equal(h.store.proposals.count(), 2);
  assert.deepEqual([model!.changes[0]!.surface, model!.status], ['model', 'rejected']);
  assert.match(h.store.gateRuns.get(model!.gateRunId!)!.reasons[0]!, /none of the issue's own eval cases passes/);
  assert.deepEqual([issue!.cause, issue!.surface, llm.roles.filter((r) => r.includes('diagnose'))], ['knowledge', 'context', ['diagnose', 'rediagnose']]);
  assert.deepEqual([note!.changes[0]!.surface, note!.status, note!.issueId], ['context', 'awaiting_approval', issue!.id]);
  assert.ok(h.store.activity.list().some((a) => a.text.startsWith('Diagnosed again after the gate rejected a stronger model: now a knowledge issue')));
  h.close();
});
