import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import {
  finishModelRun,
  modelRun,
  NOTABLE_ORDERS as O,
  TIER_MODEL_ID,
  type AgentVersion,
  type CaseResult,
  type ChatResult,
  type EvalRun,
  type JsonResult,
  type LlmClient,
  type LlmContent,
  type LlmRequest,
  type Proposal,
  type TrialResult,
} from '@healer/agent';
import type { z } from 'zod';
import { caseResult, reusableRun, runSuite } from './evalRunner.ts';
import { decide, gateProposal } from './gate.ts';
import { goldenCases } from './golden.ts';
import { setupHealer, waitFor } from './testing.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const result = (caseId: string, passed: boolean): CaseResult => ({
  caseId,
  passed,
  passRate: passed ? 1 : 0,
  rule: 'majority',
  trials: [{ traceId: 't', passed, costUsd: 0.001, checks: passed ? [] : [{ checkId: 'c', kind: 'end_state', label: 'Refunds $42.00', passed: false, detail: 'Expected a refund of $42.00, but the run issued no refund.' }] }],
});

function run(versionId: number, results: [string, boolean][], costPerTaskUsd = 0.001): EvalRun {
  const r = results.map(([id, p]) => result(id, p));
  return { id: `er${versionId}`, versionId, status: 'done', startedAt: '', endedAt: '', trialsPerCase: 1, strictTrials: null, results: r, passRate: r.filter((x) => x.passed).length / r.length, costPerTaskUsd, totalCostUsd: 0 };
}

const title = (id: string) => `case ${id}`;

test('accepts a fix: the issue case now passes, nothing regressed', () => {
  const d = decide(run(0, [['a', true], ['b', true], ['new', false]]), run(1, [['a', true], ['b', true], ['new', true]], 0.0012), ['new'], title);
  assert.equal(d.decision, 'accept');
  assert.deepEqual(d.fixedCaseIds, ['new']);
  assert.deepEqual(d.regressedCaseIds, []);
  assert.match(d.reasons[0]!, /^Accepted/);
  assert.ok(d.reasons.some((r) => r.includes('67% (2 of 3 cases) on version 0, 100% (3 of 3) on version 1')));
  assert.ok(d.reasons.some((r) => r.includes('Cost per task: $0.0010 on version 0, $0.0012 on version 1 (+20%)')));
});

test('rejects a regression even when the pass rate holds', () => {
  const d = decide(run(0, [['clean', true], ['new', false]]), run(2, [['clean', false], ['new', true]]), null, title);
  assert.equal(d.decision, 'reject');
  assert.deepEqual(d.regressedCaseIds, ['clean']);
  assert.deepEqual(d.fixedCaseIds, ['new']);
  assert.match(d.reasons[0]!, /^Rejected: 1 case that passed before now fails\./);
  assert.ok(d.reasons.some((r) => r.startsWith('Regressed: "case clean"') && r.includes('Expected a refund of $42.00')));
});

test('rejects a lower pass rate', () => {
  // Case "b" is new to the candidate run only, so it is not compared.
  const d = decide(run(0, [['a', true], ['c', false]]), run(3, [['a', false], ['c', false], ['b', true]]), null, title);
  assert.equal(d.decision, 'reject');
  assert.match(d.reasons[0]!, /now fails, and the pass rate dropped/);
});

test("rejects when none of the issue's cases passes", () => {
  const d = decide(run(0, [['a', true], ['new', false]]), run(4, [['a', true], ['new', false]]), ['new'], title);
  assert.equal(d.decision, 'reject');
  assert.match(d.reasons[0]!, /none of the issue's own eval cases passes/);
  assert.ok(d.reasons.some((r) => r.startsWith('Still failing: "case new"')));
});

test('a change made only to save money leads with cost per task', () => {
  const accept = decide(run(0, [['a', true], ['b', false]], 0.002), run(5, [['a', true], ['b', false]], 0.0008), null, title, { costFirst: true });
  assert.equal(accept.decision, 'accept');
  assert.equal(accept.reasons[0], 'Accepted: cost per task goes from $0.0020 on version 0 to $0.0008 on version 5 (-60%), no case regressed and the pass rate did not drop.');
  assert.equal(accept.reasons[1], 'Pass rate: 50% (1 of 2 cases) on version 0, 50% (1 of 2) on version 5 (no change).');
  assert.ok(!accept.reasons.some((r) => r.startsWith('Cost per task')), 'cost is not repeated');

  const reject = decide(run(0, [['a', true], ['b', true]], 0.002), run(6, [['a', true], ['b', false]], 0.0008), null, title, { costFirst: true });
  assert.match(reject.reasons[0]!, /^Rejected: cost per task would go from \$0\.0020 on version 0 to \$0\.0008 on version 6 \(-60%\), but 1 case that passed before now fails, and the pass rate dropped\.$/);
  assert.match(reject.reasons[1]!, /\(-50 points\)\.$/);
});

test('a routed candidate is rejected when it sends a capability case to the small model, whatever the trials say', () => {
  const routing = { easyTier: 'haiku' as const, hardTier: 'sonnet' as const, cases: [{ caseId: 'hard', score: 0.12, needsStrong: false, capability: true, strict: false }, { caseId: 'other', score: 0.91, needsStrong: true, capability: true, strict: false }], dataset: { size: 40, toHard: 15 } };
  const d = decide(run(0, [['hard', true], ['other', true]], 0.01), run(7, [['hard', true], ['other', true]], 0.001), null, title, { costFirst: true, routing });
  assert.equal(d.decision, 'reject');
  assert.match(d.reasons[0]!, /^Rejected: cost per task would go from .+, but 1 capability case is routed to haiku\.$/);
  assert.ok(d.reasons.includes('Misrouted: "case hard" belongs to a capability issue, but the router sends it to haiku (router score 0.12).'));
  const ok = decide(run(0, [['hard', true]], 0.01), run(8, [['hard', true]], 0.001), null, title, { costFirst: true, routing: { ...routing, cases: [routing.cases[1]!] } });
  assert.equal(ok.decision, 'accept');
  assert.ok(ok.reasons.includes('Routing: all 1 capability case goes to sonnet (router score 0.91).'));
  assert.ok(ok.reasons.includes('Routing share: of the 40 requests in the router dataset, it sends 15 (38%) to sonnet and the other 25 to haiku.'));
});

test('a routed candidate is rejected when it sends a strict case to the small model, and accepted when strict cases go to the hard tier', () => {
  const route = (caseId: string, score: number, kind: { capability?: boolean; strict?: boolean }) => ({ caseId, score, needsStrong: score >= 0.5, capability: false, strict: false, ...kind });
  const routing = (...cases: ReturnType<typeof route>[]) => ({ easyTier: 'haiku' as const, hardTier: 'sonnet' as const, cases, dataset: { size: 40, toHard: 15 } });
  const base = run(0, [['refund', true], ['cancel', true], ['hard', true]], 0.01);
  const cand = run(7, [['refund', true], ['cancel', true], ['hard', true]], 0.001);

  const d = decide(base, cand, null, title, { costFirst: true, routing: routing(route('refund', 0.31, { strict: true }), route('cancel', 0.77, { strict: true }), route('hard', 0.9, { capability: true })) });
  assert.equal(d.decision, 'reject', 'every trial passed, but a money-moving case goes to the small tier');
  assert.match(d.reasons[0]!, /^Rejected: cost per task would go from .+, but 1 strict case is routed to haiku\.$/);
  assert.ok(d.reasons.includes('Misrouted: "case refund" is strict (it moves money), but the router sends it to haiku (router score 0.31).'));
  assert.ok(d.reasons.includes('Routing: all 1 capability case goes to sonnet (router score 0.90).'), 'the capability check still runs');
  assert.ok(!d.reasons.some((r) => r.startsWith('Routing: all') && r.includes('strict')));

  const both = decide(base, cand, null, title, { costFirst: true, routing: routing(route('hard', 0.2, { capability: true, strict: true })) });
  assert.match(both.reasons[0]!, /but 1 capability case is routed to haiku, and 1 strict case is routed to haiku\.$/);
  assert.ok(both.reasons.includes('Misrouted: "case hard" belongs to a capability issue and is strict (it moves money), but the router sends it to haiku (router score 0.20).'));

  const ok = decide(base, cand, null, title, { costFirst: true, routing: routing(route('refund', 0.81, { strict: true }), route('cancel', 0.77, { strict: true })) });
  assert.equal(ok.decision, 'accept', ok.reasons.join('\n'));
  assert.ok(ok.reasons.includes('Routing: all 2 strict cases go to sonnet (router score 0.81, router score 0.77).'));
  assert.ok(ok.reasons.includes('Routing: no enabled eval case belongs to a capability issue, so routing was not checked case by case.'));

  const none = decide(base, cand, null, title, { costFirst: true, routing: routing() });
  assert.ok(none.reasons.includes('Routing: no enabled eval case is strict, so where money-moving cases go was not checked.'));
});

const twoTrials = (caseId: string, passes: number): CaseResult => caseResult(caseId, [0, 1].map((i) => ({ ...result(caseId, i < passes).trials[0]! })), 'majority');

test('a case that regressed in the first round and passes on the candidate the second time is accepted as run-to-run variation, and is not fixed', () => {
  const base = run(0, [['a', true], ['clean', true]]);
  const cand = run(1, [['a', true], ['clean', false]]);
  const rechecks = [{ caseId: 'clean', base: twoTrials('clean', 2), candidate: twoTrials('clean', 2) }];
  const d = decide(base, cand, null, title, { rechecks });
  assert.equal(d.decision, 'accept', d.reasons.join('\n'));
  assert.deepEqual([d.regressedCaseIds, d.fixedCaseIds], [[], []]);
  assert.ok(d.reasons.includes('Pass rate: 100% (2 of 2 cases) on version 0, 100% (2 of 2) on version 1 (no change).'), 'the second round replaces the first in the pass rate');
  assert.ok(
    d.reasons.includes(
      'Ran again: "case clean" passed on version 0 (1 of 1 trials passed) and failed on version 1 (0 of 1 trials passed) in the first round. In the second round it passed on version 0 (2 of 2 trials passed) and passed on version 1 (2 of 2 trials passed), so the first failure is treated as run-to-run variation and not counted as a regression.',
    ),
    d.reasons.join('\n'),
  );
  assert.ok(!d.reasons.some((r) => r.startsWith('Regressed:') || r.startsWith('Fixed:')));
});

test('a case that fails on the candidate again in the second round is a regression, with the failing check from the second round', () => {
  const second = twoTrials('clean', 1);
  second.trials[1]!.checks[0]!.detail = 'Second round: the run issued no refund.';
  const d = decide(run(0, [['clean', true]]), run(1, [['clean', false]]), null, title, { rechecks: [{ caseId: 'clean', base: twoTrials('clean', 2), candidate: second }] });
  assert.equal(d.decision, 'reject');
  assert.deepEqual(d.regressedCaseIds, ['clean']);
  assert.match(d.reasons[0]!, /^Rejected: 1 case that passed before now fails, and the pass rate dropped\.$/);
  assert.ok(d.reasons.some((r) => r.startsWith('Ran again: "case clean"') && r.endsWith('In the second round it passed on version 0 (2 of 2 trials passed) and failed on version 1 (1 of 2 trials passed), so it failed twice and counts as a regression.')));
  assert.ok(d.reasons.includes('Regressed: "case clean" passed on version 0 and fails on version 1 (1 of 2 trials passed). In a failing trial, "Refunds $42.00" failed: Second round: the run issued no refund.'));
});

test('a case whose base fails in the second round cannot show a regression, and is not counted as fixed when the candidate passes', () => {
  const both = decide(run(0, [['clean', true]]), run(1, [['clean', false]]), null, title, { rechecks: [{ caseId: 'clean', base: twoTrials('clean', 1), candidate: twoTrials('clean', 0) }] });
  assert.equal(both.decision, 'accept', both.reasons.join('\n'));
  assert.deepEqual(both.regressedCaseIds, []);
  assert.ok(both.reasons.some((r) => r.endsWith('In the second round it failed on version 0 (1 of 2 trials passed) and failed on version 1 (0 of 2 trials passed), so the case fails on the base too and cannot show a regression.')));

  const flipped = decide(run(0, [['clean', true]]), run(1, [['clean', false]]), ['clean'], title, { rechecks: [{ caseId: 'clean', base: twoTrials('clean', 0), candidate: twoTrials('clean', 2) }] });
  assert.deepEqual([flipped.fixedCaseIds, flipped.regressedCaseIds], [[], []]);
  assert.equal(flipped.decision, 'accept', "the issue's own case is judged on its second round too");
  assert.ok(flipped.reasons.some((r) => r.endsWith('so the case fails on the base too and cannot show a regression, and it is not counted as fixed.')));
  assert.ok(!flipped.reasons.some((r) => r.startsWith('Fixed:')));
});

const trial = (passed: boolean): TrialResult => ({
  traceId: 't',
  passed,
  costUsd: 0.001,
  checks: passed ? [] : [{ checkId: 'refund', kind: 'end_state', label: 'Refunds $42.00', passed: false, detail: 'Expected a refund of $42.00, but the run issued RF-0002 of $40.00.' }],
});
const strictRun = (versionId: number, results: CaseResult[]): EvalRun => ({ ...run(versionId, []), strictTrials: 10, results });

test('the every-trial rule: 9 of 10 trials fails a strict case, which regresses against 10 of 10, and the reason says what the gate could see', () => {
  const nine = caseResult('refund', [...Array.from({ length: 9 }, () => trial(true)), trial(false)], 'every');
  assert.equal(nine.passed, false);
  assert.equal(caseResult('refund', [...Array.from({ length: 9 }, () => trial(true)), trial(false)], 'majority').passed, true, 'the majority rule would pass it');
  const ten = caseResult('refund', Array.from({ length: 10 }, () => trial(true)), 'every');
  const d = decide(strictRun(1, [ten]), strictRun(2, [nine]), null, () => 'Clean refund inside the window', { costFirst: true });
  assert.equal(d.decision, 'reject');
  assert.deepEqual(d.regressedCaseIds, ['refund']);
  assert.ok(
    d.reasons.includes(
      'Strict: "Clean refund inside the window" passed 10 of 10 trials on version 1, and failed trial 10 on version 2. A request that fails 1 time in 5 would show at least one failure in 10 trials 89% of the time. In the failing trial, "Refunds $42.00" failed: Expected a refund of $42.00, but the run issued RF-0002 of $40.00.',
    ),
    d.reasons.join('\n'),
  );

  const both = decide(strictRun(1, [ten]), strictRun(2, [ten]), null, () => 'Clean refund inside the window', { costFirst: true });
  assert.equal(both.decision, 'accept');
  assert.ok(both.reasons.includes('Strict: "Clean refund inside the window" passed 10 of 10 trials on version 1 and on version 2. A request that fails 1 time in 5 would show at least one failure in 10 trials 89% of the time.'));
});

test('a strict case that fails on the base cannot regress, and the reasons say the gate could not use it', () => {
  const stoppedEarly = caseResult('refund', [trial(true), trial(false)], 'every');
  const ten = caseResult('refund', Array.from({ length: 10 }, () => trial(true)), 'every');
  const d = decide(strictRun(1, [stoppedEarly]), strictRun(2, [stoppedEarly]), null, () => 'Clean refund', { costFirst: true });
  assert.equal(d.decision, 'accept');
  assert.deepEqual(d.regressedCaseIds, []);
  const reason = d.reasons.find((r) => r.startsWith('Strict:'))!;
  assert.match(reason, /^Strict: "Clean refund" failed trial 2 on version 1, so its other 8 were skipped, and failed trial 2 on version 2, so its other 8 were skipped\./);
  assert.match(reason, /Because it already fails on version 1, it counts as failing on the base and cannot regress, so this gate could not use it\./);
  const fixedByNoise = decide(strictRun(1, [stoppedEarly]), strictRun(2, [ten]), null, () => 'Clean refund').reasons.find((r) => r.startsWith('Strict:'))!;
  assert.match(fixedByNoise, /cannot regress, so this gate could not use it\. On version 1, "Refunds \$42\.00" failed: Expected a refund of \$42\.00/);
});

test('the high-stakes rule marks the golden clean refund and cancellation strict, and the status question not', () => {
  const strict = Object.fromEntries(goldenCases().map((c) => [c.id, c.strict]));
  assert.deepEqual(strict, { golden_status: false, golden_clean_refund: true, golden_cancel: true, golden_address: false, golden_in_transit: false, golden_greeting: false });
});

// The agent refunds the watering can and changes Ava's address correctly, except that the small model refunds $40.00
// on every fifth attempt at the refund: a failure one time in five.
class FlakyHaikuLlm implements LlmClient {
  requests: LlmRequest[] = [];
  haikuRefunds = 0;

  async chat(req: LlmRequest): Promise<ChatResult> {
    this.requests.push(req);
    const last = req.messages.at(-1)!;
    let toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    const id = `toolu_${crypto.randomUUID()}`;
    if (typeof last.content === 'string' && last.content.includes('watering can')) {
      const wrong = req.model === TIER_MODEL_ID.haiku && ++this.haikuRefunds % 5 === 0;
      toolUses = [{ id, name: 'issue_refund', input: { order_id: O.cleanRefund, amount: wrong ? 40 : 42, method: 'original_payment', reason: 'leaks' } }];
    } else if (typeof last.content === 'string' && last.content.includes('Clifton')) {
      toolUses = [{ id, name: 'update_shipping_address', input: { order_id: O.processing, address: '8 Clifton Park Road, Bristol BS8 3HL' } }];
    }
    const content: LlmContent = toolUses.length ? toolUses.map((t) => ({ type: 'tool_use' as const, ...t })) : [{ type: 'text', text: 'All done.' }];
    const run = finishModelRun(modelRun(req, req.role, { system: req.system, messages: req.messages }), { content }, req.model, 1000, 50);
    return { stopReason: toolUses.length ? 'tool_use' : 'end_turn', text: toolUses.length ? '' : 'All done.', toolUses, content, run };
  }

  async json<T>(_req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    throw new Error('No judge call is expected');
  }
}

async function flakyHealer() {
  const llm = new FlakyHaikuLlm();
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  await h.call('PUT', '/api/healer/settings', { trialsPerCase: 3 });
  for (const c of h.store.evalCases.list()) if (c.id !== 'golden_clean_refund' && c.id !== 'golden_address') await h.call('PATCH', `/api/healer/evals/${c.id}`, { enabled: false });
  const sonnet = (await h.call<AgentVersion>('POST', '/api/healer/model/tier', { tier: 'sonnet' })).body;
  return { h, llm, sonnet };
}

const haikuRefundCalls = (llm: FlakyHaikuLlm) => llm.requests.filter((r) => r.model === TIER_MODEL_ID.haiku && typeof r.messages.at(-1)!.content === 'string' && (r.messages.at(-1)!.content as string).includes('watering can')).length;

test('a tier switch down to haiku that fails a strict case one time in five: the majority rule accepts, the every-trial rule rejects and stops early', async () => {
  const { h, llm, sonnet } = await flakyHealer();
  const proposal = (await h.call<Proposal>('POST', '/api/healer/proposals', { title: 'Move to haiku', rationale: 'Cheaper.', changes: [{ surface: 'model', op: 'set_model', model: { ...sonnet.model, tier: 'haiku' } }] })).body;

  // The old rule: three trials per case under a majority.
  const oldBase = await runSuite(h.healer, sonnet.id);
  const oldCandidate = await runSuite(h.healer, proposal.candidateVersionId);
  assert.equal(oldCandidate.strictTrials, null);
  assert.deepEqual(oldCandidate.results.map((r) => [r.caseId, r.rule, r.trials.length, r.passed]), [['golden_clean_refund', 'majority', 3, true], ['golden_address', 'majority', 3, true]]);
  assert.equal(decide(oldBase, oldCandidate, null, (id) => id, { costFirst: true }).decision, 'accept');

  // A strict gate cannot reuse the majority result for the strict case, only for the other one.
  const reuse = reusableRun(h.healer, sonnet.id, true);
  assert.deepEqual(reuse.missing.map((c) => c.id), ['golden_clean_refund']);
  assert.deepEqual(reuse.kept.map((r) => r.caseId), ['golden_address']);
  assert.equal(reuse.prior?.id, oldBase.id);

  const before = haikuRefundCalls(llm);
  const gate = await gateProposal(h.healer, proposal.id);
  assert.equal(gate.decision, 'reject', gate.reasons.join('\n'));
  assert.deepEqual(gate.regressedCaseIds, ['golden_clean_refund']);
  const base = h.store.evalRuns.get(gate.baseRunId!)!;
  const candidate = h.store.evalRuns.get(gate.candidateRunId!)!;
  assert.equal(base.strictTrials, 10);
  const baseRefund = base.results.find((r) => r.caseId === 'golden_clean_refund')!;
  assert.deepEqual([baseRefund.rule, baseRefund.trials.length, baseRefund.passed], ['every', 10, true]);
  assert.equal(base.results.find((r) => r.caseId === 'golden_address')!.trials.length, 3, 'the other case kept its ordinary trials');
  const refund = candidate.results.find((r) => r.caseId === 'golden_clean_refund')!;
  assert.equal(refund.rule, 'every');
  assert.equal(refund.passed, false);
  assert.ok(refund.trials.length < 10, `stopped after the failed trial, ran ${refund.trials.length}`);
  const [again] = gate.rechecks!;
  assert.equal(again!.caseId, 'golden_clean_refund');
  assert.deepEqual([again!.base.rule, again!.base.trials.length, again!.base.passed], ['every', 10, true], 'the second round uses the every-trial rule and the strict trial count');
  assert.deepEqual([again!.candidate.rule, again!.candidate.passed], ['every', false]);
  assert.ok(again!.candidate.trials.length < 10, 'the second round also stops at the first failure');
  assert.equal(haikuRefundCalls(llm) - before, refund.trials.length + again!.candidate.trials.length, 'skipped trials made no model call');
  assert.ok(gate.reasons.some((r) => r.startsWith('Ran again: "Clean refund inside the window"') && r.endsWith('so it failed twice and counts as a regression.')));
  assert.ok(h.store.activity.list().some((a) => a.text === `Running a case again on version ${sonnet.id} and version ${proposal.candidateVersionId} before deciding, because it passed on the base and failed on the candidate: "Clean refund inside the window"`));
  const reason = gate.reasons.find((r) => r.startsWith('Strict:'))!;
  assert.match(reason, new RegExp(`^Strict: "Clean refund inside the window" passed 10 of 10 trials on version ${sonnet.id}, and failed trial \\d+ on version ${proposal.candidateVersionId}, so its other \\d+ were skipped\\.`));
  assert.match(reason, /A request that fails 1 time in 5 would show at least one failure in 10 trials 89% of the time\./);
  assert.match(reason, /issued RF-0002 of \$40\.00/);

  // A stopped strict result is reused by the next strict gate; a strict one is not reused by an ordinary run.
  assert.deepEqual(reusableRun(h.healer, proposal.candidateVersionId, true).missing, []);
  assert.deepEqual(reusableRun(h.healer, sonnet.id, true).missing, []);
  assert.equal(reusableRun(h.healer, sonnet.id, false).kept.find((r) => r.caseId === 'golden_clean_refund')!.rule, 'majority');
  h.close();
});

test('a context-only proposal runs strict cases with ordinary trials under the majority rule', async () => {
  const { h, sonnet } = await flakyHealer();
  const proposal = (await h.call<Proposal>('POST', '/api/healer/proposals', { title: 'A note', rationale: 'Kinder.', changes: [{ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: 'Thank the customer.' }] })).body;
  const gate = await gateProposal(h.healer, proposal.id);
  assert.equal(gate.decision, 'accept', gate.reasons.join('\n'));
  for (const id of [gate.baseRunId!, gate.candidateRunId!]) {
    const r = h.store.evalRuns.get(id)!;
    assert.equal(r.strictTrials, null);
    assert.equal(r.versionId === sonnet.id || r.versionId === proposal.candidateVersionId, true);
    assert.deepEqual(r.results.map((x) => [x.caseId, x.rule, x.trials.length]), [['golden_clean_refund', 'majority', 3], ['golden_address', 'majority', 3]]);
  }
  assert.ok(!gate.reasons.some((r) => r.startsWith('Strict:')));
  assert.deepEqual(gate.rechecks, [], 'nothing regressed, so no case ran a second time');
  assert.ok(!gate.reasons.some((r) => r.startsWith('Ran again:')));
  const patched = await h.call<{ strict: boolean }>('PATCH', '/api/healer/evals/golden_clean_refund', { strict: false });
  assert.equal(patched.body.strict, false, 'a person can switch it off');
  assert.equal((await h.call('PUT', '/api/healer/settings', { strictTrials: 2 })).status, 400);
  assert.equal((await h.call<{ strictTrials: number }>('PUT', '/api/healer/settings', { strictTrials: 20 })).body.strictTrials, 20);
  h.close();
});

// The candidate, which has the note "Thank the customer.", gets the address change wrong on its first two attempts only.
class FirstRoundSlip extends FlakyHaikuLlm {
  slips = 0;

  override async chat(req: LlmRequest): Promise<ChatResult> {
    const last = req.messages.at(-1)!.content;
    if (req.system.includes('Thank the customer.') && typeof last === 'string' && last.includes('Clifton') && ++this.slips <= 2) {
      this.requests.push(req);
      const content: LlmContent = [{ type: 'text', text: 'I will look into it.' }];
      return { stopReason: 'end_turn', text: 'I will look into it.', toolUses: [], content, run: finishModelRun(modelRun(req, req.role, { system: req.system, messages: req.messages }), { content }, req.model, 1000, 50) };
    }
    return super.chat(req);
  }
}

test('a gate whose only regression does not happen again in the second round accepts, runs the case on both versions, and says why', async () => {
  const llm = new FirstRoundSlip();
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  await h.call('PUT', '/api/healer/settings', { trialsPerCase: 3 });
  for (const c of h.store.evalCases.list()) if (c.id !== 'golden_clean_refund' && c.id !== 'golden_address') await h.call('PATCH', `/api/healer/evals/${c.id}`, { enabled: false });
  const proposal = (await h.call<Proposal>('POST', '/api/healer/proposals', { title: 'A note', rationale: 'Kinder.', changes: [{ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: 'Thank the customer.' }] })).body;
  const progress: [number, number][] = [];
  const gate = await gateProposal(h.healer, proposal.id, (done, total) => progress.push([done, total]));

  assert.equal(gate.decision, 'accept', gate.reasons.join('\n'));
  assert.deepEqual([gate.regressedCaseIds, gate.fixedCaseIds], [[], []]);
  const candidate = h.store.evalRuns.get(gate.candidateRunId!)!;
  assert.equal(candidate.results.find((r) => r.caseId === 'golden_address')!.passed, false, 'the first round failed it');
  assert.deepEqual(
    gate.rechecks!.map((r) => [r.caseId, r.base.rule, r.base.trials.length, r.base.passed, r.candidate.trials.length, r.candidate.passed]),
    [['golden_address', 'majority', 3, true, 3, true]],
  );
  for (const t of [...gate.rechecks![0]!.base.trials, ...gate.rechecks![0]!.candidate.trials]) assert.ok(h.store.trace(t.traceId), 'second-round traces are kept');
  assert.deepEqual(progress.at(-1), [6, 6], 'the second round reports its own progress');
  assert.ok(
    gate.reasons.includes(
      `Ran again: "Change the address of an order still processing" passed on version 0 (3 of 3 trials passed) and failed on version ${proposal.candidateVersionId} (1 of 3 trials passed) in the first round. In the second round it passed on version 0 (3 of 3 trials passed) and passed on version ${proposal.candidateVersionId} (3 of 3 trials passed), so the first failure is treated as run-to-run variation and not counted as a regression.`,
    ),
    gate.reasons.join('\n'),
  );
  h.close();
});
