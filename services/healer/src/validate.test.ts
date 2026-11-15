import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import {
  finishModelRun,
  modelRun,
  NOTABLE_ORDERS as O,
  ScriptedLlm,
  seedSnapshot,
  TIER_MODEL_ID,
  type ChatResult,
  type EvalCase,
  type EvalCheckSpec,
  type Job,
  type JsonResult,
  type LlmClient,
  type LlmContent,
  type LlmRequest,
  type Proposal,
} from '@healer/agent';
import type { z } from 'zod';
import { JUDGE_SYSTEM } from './judge.ts';
import { runSuite } from './evalRunner.ts';
import { POLICY_RULES } from './policy.ts';
import { makeTrace, setupHealer, waitFor } from './testing.ts';
import { REFERENCE_NOTE_ID, validateCase } from './validate.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const policy: EvalCheckSpec = { id: 'policy', kind: 'invariant', label: 'Every shop policy rule holds', params: {} };
const rubric = (id: string, criterion: string): EvalCheckSpec => ({ id, kind: 'rubric', label: criterion, params: { criterion } });

function openedItemCase(checks: EvalCheckSpec[]): EvalCase {
  return {
    id: 'ev_test',
    createdAt: new Date().toISOString(),
    title: 'Refund on opened items',
    origin: 'failure',
    sourceTraceId: null,
    issueId: null,
    customerId: 'c_tom',
    history: [],
    message: `Please refund everything on ${O.openedItem}, I opened two of the covers.`,
    env: seedSnapshot(),
    checks,
    enabled: true,
    strict: false,
    validation: null,
  };
}

async function healerWith(llm: LlmClient) {
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  return h;
}

const graded = (...results: [string, boolean][]) => ({ results: results.map(([id, passed]) => ({ id, passed, detail: passed ? 'Met.' : `It did not do ${id}.` })) });

test('validateCase: a policy conflict and a rubric failing both reference runs are set aside, one failing once is flagged, policy stays', async () => {
  const llm = new ScriptedLlm()
    .pushJson(graded(['items', true], ['sorry', true]))
    .push({ text: 'I can refund $59.40.' })
    .pushJson(graded(['items', false], ['sorry', false]))
    .push({ text: 'I can refund $59.40.' })
    .pushJson(graded(['items', false], ['sorry', true]))
    .push(...Array.from({ length: 4 }, () => ({ text: 'Sorry, I can refund $59.40.' })))
    .pushJson(...Array.from({ length: 4 }, () => graded(['sorry', true])));
  const h = await healerWith(llm);
  const source = makeTrace('c_tom', (e) => e.addRefund(O.openedItem, 66, 'original_payment', 'opened'));
  const checks = [
    policy,
    { id: 'c1', kind: 'end_state', label: 'Refund $66.00 on PM-1009', params: { orderId: O.openedItem, refund: { amount: 66 } } },
    rubric('items', "The reply lists every item's amount"),
    rubric('sorry', 'The reply apologises'),
    { id: 'c4', kind: 'tool_sequence', label: 'No cancellation', params: { mustNotCall: ['cancel_order'] } },
  ] satisfies EvalCheckSpec[];
  const tested = await validateCase(h.healer, openedItemCase(checks), source);

  assert.deepEqual(tested.checks.map((c) => c.id), ['policy', 'sorry', 'c4']);
  const v = tested.validation!;
  assert.deepEqual(v.setAside.map((s) => s.check.id), ['c1', 'items']);
  assert.match(v.setAside[0]!.reason, /^Conflicts with shop policy: .*at most \$59\.40 is refundable/);
  assert.match(v.setAside[1]!.reason, /^Failed on both reference runs \(It did not do items\)/);
  assert.deepEqual(v.flagged, [{ checkId: 'sorry', reason: 'Failed on one of the 2 reference runs (It did not do sorry).' }]);
  assert.equal(v.catchesSource, true);
  assert.deepEqual(v.caughtBy, ['policy']);
  assert.equal(v.referenceTier, 'sonnet');
  assert.equal(v.referenceTraceIds.length, 2);
  assert.ok(v.referenceTraceIds.every((id) => h.store.trace(id)?.tierUsed === 'sonnet'));

  assert.deepEqual(v.stability!.checks.map((c) => [c.checkId, c.passed, c.regraded]), [
    ['policy', [true, true, true, true], null],
    ['sorry', [true, true, true, true], null],
    ['c4', [true, true, true, true], null],
  ]);
  assert.equal(v.stability!.traceIds.length, 4);

  const agentCalls = llm.requests.filter((r) => r.role === 'agent');
  assert.equal(agentCalls.length, 6);
  for (const r of agentCalls.slice(0, 2)) {
    assert.equal(r.model, TIER_MODEL_ID.sonnet);
    for (const rule of POLICY_RULES) assert.ok(r.system.includes(rule.description), `the reference agent is shown "${rule.label}"`);
  }
  const lines = h.store.activity.latest(20).map((a) => a.text);
  assert.ok(lines.includes(`Set aside a check from 'Refund on opened items': "Refund $66.00 on PM-1009" conflicts with shop policy: it demands a refund of $66.00 on PM-1009, but at most $59.40 is refundable.`));
  assert.ok(lines.includes(`Set aside a check from 'Refund on opened items': "The reply lists every item's amount" failed on both reference runs (It did not do items).`));
  assert.ok(lines.includes(`Flagged a check from 'Refund on opened items': "The reply apologises" failed on one of the 2 reference runs (It did not do sorry).`));
  assert.ok(lines.includes(`Tested 'Refund on opened items' on the reference agent (sonnet, shown every shop rule): 2 of 2 runs kept every policy rule`));
  assert.ok(lines.includes(`Ran 'Refund on opened items' 4 times on version 0 to see whether its checks hold steady: every check gave the same result on every run`));
  assert.ok(lines.includes(`'Refund on opened items' catches the failure it came from: "Every shop policy rule holds" fails on the source trace`));
  assert.ok(!lines.some((l) => l.includes('Version 0 passed it')), 'a stable case adds nothing to set aside or flag');
  h.close();
});

test('validateCase: a case that passes on its source does not catch it; runs that break a rule do not count; policy is never set aside', async () => {
  const refund = { toolUses: [{ name: 'issue_refund', input: { order_id: O.openedItem, amount: 66, method: 'original_payment', reason: 'opened' } }] };
  const llm = new ScriptedLlm().push(refund, { text: 'Refunded $66.00.' }, refund, { text: 'Refunded $66.00.' }, ...Array.from({ length: 4 }, () => ({ text: 'Let me check.' })));
  const h = await healerWith(llm);
  const checks = [policy, { id: 'none', kind: 'end_state', label: 'No refund', params: { orderId: O.openedItem, refund: { none: true } } }] satisfies EvalCheckSpec[];
  const tested = await validateCase(h.healer, openedItemCase(checks), makeTrace('c_tom', () => {}));

  assert.deepEqual(tested.checks.map((c) => c.id), ['policy', 'none'], 'neither run kept every rule, so neither tests a check');
  assert.equal(tested.validation!.catchesSource, false);
  assert.deepEqual(tested.validation!.caughtBy, []);
  assert.deepEqual([tested.validation!.setAside, tested.validation!.flagged], [[], []]);
  const lines = h.store.activity.latest(20).map((a) => a.text);
  assert.ok(lines.includes(`Tested 'Refund on opened items' on the reference agent (sonnet, shown every shop rule): neither run kept every policy rule, so the runs set aside no check`));
  assert.ok(lines.includes(`'Refund on opened items' does not catch the failure it came from: every check it keeps passes on the source trace`));

  llm.push(...Array.from({ length: 6 }, () => ({ text: 'Let me check.' })));
  const noSource = await validateCase(h.healer, openedItemCase([policy]), null);
  assert.equal(noSource.validation!.catchesSource, null);
  assert.deepEqual(noSource.checks, [policy]);
  h.close();
});

test('validateCase: across four live runs, a rubric the grader scores differently on the same reply is set aside; a rubric or code check that flips with the agent is flagged and kept; policy is never touched', async () => {
  const refund = { toolUses: [{ name: 'issue_refund', input: { order_id: O.openedItem, amount: 66, method: 'original_payment', reason: 'opened' } }] };
  const llm = new ScriptedLlm()
    .push({ text: 'Sorry, I can refund $59.40.' }, { text: 'Sorry, I can refund $59.40.' })
    .pushJson(graded(['tone', true], ['amounts', true]), graded(['tone', true], ['amounts', true]))
    .push({ text: 'Sorry, I can refund $59.40.' }, refund, { text: 'Refunded $66.00.' }, { text: 'Sorry, I can refund $59.40.' }, { text: 'I can refund $59.40.' })
    .pushJson(graded(['tone', true], ['amounts', true]), graded(['tone', false], ['amounts', false]), graded(['tone', true], ['amounts', true]), graded(['tone', true], ['amounts', false]))
    .pushJson(graded(['tone', true], ['amounts', true]), graded(['tone', true], ['amounts', false]), graded(['tone', true], ['amounts', true]), graded(['tone', true], ['amounts', false]));
  const h = await healerWith(llm);
  const checks = [
    policy,
    rubric('tone', 'The reply is polite'),
    rubric('amounts', 'The reply gives the refundable amount'),
    { id: 'sorry', kind: 'exact_match', label: 'Says sorry', params: { contains: 'sorry' } },
  ] satisfies EvalCheckSpec[];
  const tested = await validateCase(h.healer, openedItemCase(checks), null);
  const v = tested.validation!;
  const stable = v.stability!;

  assert.deepEqual(tested.checks.map((c) => c.id), ['policy', 'amounts', 'sorry']);
  assert.deepEqual(v.setAside.map((s) => s.check.id), ['tone']);
  assert.equal(
    v.setAside[0]!.reason,
    `The grader gave two different results for the same reply: on trace ${stable.traceIds[1]} it failed the first time and passed the second.`,
  );
  const kept = "passed it on 2 of 4 runs: what the agent does varies from run to run, while the check gives the same result for the same reply.";
  assert.deepEqual(v.flagged, [
    { checkId: 'amounts', reason: `Version 0 ${kept}` },
    { checkId: 'sorry', reason: `Version 0 ${kept}` },
  ]);
  const policyRow = stable.checks.find((c) => c.checkId === 'policy')!;
  assert.deepEqual(policyRow.passed, [true, false, true, true], 'the policy invariant flipped on the live runs');
  assert.ok(!v.flagged.some((f) => f.checkId === 'policy') && !v.setAside.some((s) => s.check.id === 'policy'));
  assert.deepEqual(stable.checks.find((c) => c.checkId === 'amounts')!.regraded, [true, false, true, false]);
  assert.equal(stable.checks.find((c) => c.checkId === 'sorry')!.regraded, null, 'a code check is never graded twice');

  const live = llm.requests.filter((r) => r.role === 'agent').slice(2);
  assert.ok(live.every((r) => !r.system.includes(POLICY_RULES[0]!.description)), 'the stability runs use the live version, not the reference one');
  assert.equal(llm.requests.filter((r) => r.role === 'judge').length, 10, 'two reference grades, four first grades and four second grades');
  const lines = h.store.activity.latest(30).map((a) => a.text);
  assert.ok(lines.includes(`Set aside a check from 'Refund on opened items': "The reply is polite" the grader gave two different results for the same reply: on trace ${stable.traceIds[1]} it failed the first time and passed the second.`));
  assert.ok(lines.includes(`Flagged a check from 'Refund on opened items': "Says sorry" version 0 ${kept}`));
  assert.ok(lines.includes(`Ran 'Refund on opened items' 4 times on version 0 to see whether its checks hold steady: 3 of 3 checks besides shop policy gave different results on different runs`));
  h.close();
});

// The agent answers by keyword and follows a 30-day rule when its prompt has one; the grader fails any criterion about
// itemised amounts, which no correct reply to a late refund gives; diagnosis writes a case with that over-strict rubric.
class LateRefundLlm implements LlmClient {
  requests: LlmRequest[] = [];

  async chat(req: LlmRequest): Promise<ChatResult> {
    this.requests.push(req);
    const last = req.messages.at(-1)!;
    let text = 'Hello! How can I help?';
    let toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    if (typeof last.content !== 'string') text = 'All done.';
    else if (last.content.includes(O.outsideRefundWindow)) {
      if (req.system.includes('30 days')) text = 'Sorry, that order is outside our 30-day refund window.';
      else toolUses = [{ id: `toolu_${crypto.randomUUID()}`, name: 'issue_refund', input: { order_id: O.outsideRefundWindow, amount: 24, method: 'original_payment', reason: 'broken' } }];
    } else if (last.content.includes('watering can')) {
      toolUses = [{ id: `toolu_${crypto.randomUUID()}`, name: 'issue_refund', input: { order_id: O.cleanRefund, amount: 42, method: 'original_payment', reason: 'leaks' } }];
    } else if (last.content.includes('cancel order PM-1020 right away')) toolUses = [{ id: `toolu_${crypto.randomUUID()}`, name: 'cancel_order', input: { order_id: 'PM-1020' } }];
    else if (last.content.includes('Clifton')) toolUses = [{ id: `toolu_${crypto.randomUUID()}`, name: 'update_shipping_address', input: { order_id: O.processing, address: '8 Clifton Park Road, Bristol BS8 3HL' } }];
    const content: LlmContent = toolUses.length ? toolUses.map((t) => ({ type: 'tool_use' as const, ...t })) : [{ type: 'text', text }];
    const run = finishModelRun(modelRun(req, req.role, { system: req.system, messages: req.messages }), { content }, req.model, 1000, 50);
    return { stopReason: toolUses.length ? 'tool_use' : 'end_turn', text: toolUses.length ? '' : text, toolUses, content, run };
  }

  async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    this.requests.push(req);
    const message = req.messages[0]!.content as string;
    let value: unknown;
    if (req.role === 'judge' && req.system === JUDGE_SYSTEM) {
      const ok = { detail: 'Fine.', passed: true };
      value = { truthful: ok, grounded: ok, customer_notes: { applicable: false, detail: 'No notes.', passed: true }, refund_request: null, cancel_request: false, preferences: [] };
    } else if (req.role === 'judge') {
      value = { results: [...message.matchAll(/^- \[(\w+)\] (.*)$/gm)].map((m) => ({ id: m[1], detail: m[2]!.includes('every item') ? 'No amounts listed.' : 'Met.', passed: !m[2]!.includes('every item') })) };
    } else if (req.role === 'diagnose') {
      value = {
        reasoning: 'Nothing told the agent about the 30-day window.',
        covering_quote: null,
        attach_to: null,
        new_issue: { title: 'Refunds issued after the 30-day window', summary: 'Refunds are allowed only within 30 days of delivery.', cause: 'knowledge', scope: 'shop' },
        eval_case: {
          title: 'Decline a refund 52 days after delivery',
          checks: [
            { kind: 'end_state', label: 'No refund on PM-1002', params: { orderId: O.outsideRefundWindow, refund: { none: true } } },
            { kind: 'rubric', label: 'Lists every amount', params: { criterion: "The reply lists every item's amount" } },
          ],
        },
      };
    } else {
      value = { title: 'Add the refund window', rationale: 'The agent did not know it.', changes: [{ op: 'add', text: 'Refunds are allowed only within 30 days of delivery.' }] };
    }
    const parsed = req.schema.parse(value);
    return { value: parsed, run: finishModelRun(modelRun(req, req.role, { system: req.system, messages: req.messages }), parsed, req.model, 2000, 200) };
  }
}

test('loop: a set-aside check does not block a fix the remaining checks accept; the reference note goes nowhere; putting the check back reaches the next gate', async () => {
  const llm = new LateRefundLlm();
  const h = await healerWith(llm);
  await h.call('PUT', '/api/healer/settings', { trialsPerCase: 1 });

  const shopTrace = makeTrace('c_marcus', (e) => e.addRefund(O.outsideRefundWindow, 24, 'original_payment', 'broken'), {
    input: `The shears from ${O.outsideRefundWindow} broke. Refund please.`,
    output: 'I have refunded $24.00.',
    toolCalls: [{ runId: 'r', name: 'issue_refund', input: { order_id: O.outsideRefundWindow, amount: 24 }, output: {}, blockedByGuard: null }],
  });
  h.shop.publish({ type: 'trace.completed', trace: shopTrace });
  await waitFor(() => h.store.proposals.list().some((p) => p.status === 'awaiting_approval' || p.status === 'rejected'), 10_000);

  const [issue] = h.store.issues.list();
  const evalCase = h.store.evalCases.get(issue!.evalCaseIds[0]!)!;
  assert.deepEqual(evalCase.checks.map((c) => c.kind), ['invariant', 'end_state']);
  assert.deepEqual(evalCase.validation!.setAside.map((s) => s.check.label), ['Lists every amount']);
  assert.equal(evalCase.validation!.catchesSource, true);
  const [proposal] = h.store.proposals.list();
  const gate = h.store.gateRuns.get(proposal!.gateRunId!)!;
  assert.equal(gate.decision, 'accept', gate.reasons.join(' '));
  assert.deepEqual(gate.fixedCaseIds, [evalCase.id]);

  // The rule note was shown to the reference runs and to nothing else.
  const ruleText = POLICY_RULES[0]!.description;
  assert.equal(llm.requests.filter((r) => r.role === 'agent' && r.system.includes(ruleText)).length, 2, 'only the two reference runs');
  assert.equal(evalCase.validation!.stability!.versionId, 0);
  for (const id of evalCase.validation!.stability!.traceIds) assert.equal(h.store.trace(id)!.versionId, 0, 'the stability runs used the stored live version');
  for (const r of llm.requests.filter((r) => r.role !== 'agent')) assert.ok(!JSON.stringify(r).includes(ruleText), `the ${r.role} call never sees the rule note`);
  for (const v of h.store.versions.list()) assert.ok(!v.context.some((n) => n.id === REFERENCE_NOTE_ID || n.text.includes(ruleText)), `version ${v.id} has no rule note`);
  for (const p of h.store.proposals.list() as Proposal[]) assert.ok(!JSON.stringify(p).includes(ruleText));
  assert.ok(!h.shop.deployed.context.some((n) => n.text.includes(ruleText)));

  // Putting the check back: it is in the case again, and the next suite run grades it.
  const putBack = await h.call<EvalCase>('PATCH', `/api/healer/evals/${evalCase.id}`, {
    checks: [...evalCase.checks, evalCase.validation!.setAside[0]!.check],
    validation: { ...evalCase.validation!, setAside: [] },
  });
  assert.equal(putBack.status, 200);
  assert.deepEqual(putBack.body.checks.map((c) => c.label), ['Every shop policy rule holds', 'No refund on PM-1002', 'Lists every amount']);
  assert.deepEqual(putBack.body.validation!.setAside, []);
  const run = await runSuite(h.healer, proposal!.candidateVersionId);
  const result = run.results.find((r) => r.caseId === evalCase.id)!;
  assert.ok(result.trials[0]!.checks.some((c) => c.label === 'Lists every amount' && !c.passed));
  assert.equal(result.passed, false);

  // Testing it again through the route sets it aside once more.
  const job = await h.call<Job>('POST', `/api/healer/evals/${evalCase.id}/validate`);
  assert.equal(job.body.kind, 'validate');
  assert.equal(job.body.refId, evalCase.id);
  await waitFor(() => h.store.jobs.get(job.body.id)!.status !== 'running', 10_000);
  assert.equal(h.store.jobs.get(job.body.id)!.status, 'done');
  const retested = h.store.evalCases.get(evalCase.id)!;
  assert.deepEqual(retested.validation!.setAside.map((s) => s.check.label), ['Lists every amount']);
  assert.notEqual(retested.validation!.at, evalCase.validation!.at);
  assert.equal((await h.call('POST', '/api/healer/evals/nope/validate')).status, 404);
  h.close();
});
