import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CaseResult, EvalRun } from '@healer/agent';
import { decide } from './gate.ts';

const result = (caseId: string, passed: boolean): CaseResult => ({
  caseId,
  passed,
  passRate: passed ? 1 : 0,
  trials: [{ traceId: 't', passed, costUsd: 0.001, checks: passed ? [] : [{ checkId: 'c', kind: 'end_state', label: 'Refunds $42.00', passed: false, detail: 'Expected a refund of $42.00, but the run issued no refund.' }] }],
});

function run(versionId: number, results: [string, boolean][], costPerTaskUsd = 0.001): EvalRun {
  const r = results.map(([id, p]) => result(id, p));
  return { id: `er${versionId}`, versionId, status: 'done', startedAt: '', endedAt: '', trialsPerCase: 1, results: r, passRate: r.filter((x) => x.passed).length / r.length, costPerTaskUsd, totalCostUsd: 0 };
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
  const routing = { easyTier: 'haiku' as const, hardTier: 'sonnet' as const, cases: [{ caseId: 'hard', score: 0.12, needsStrong: false }, { caseId: 'other', score: 0.91, needsStrong: true }] };
  const d = decide(run(0, [['hard', true], ['other', true]], 0.01), run(7, [['hard', true], ['other', true]], 0.001), null, title, { costFirst: true, routing });
  assert.equal(d.decision, 'reject');
  assert.match(d.reasons[0]!, /^Rejected: cost per task would go from .+, but 1 capability case is routed to haiku\.$/);
  assert.ok(d.reasons.includes('Misrouted: "case hard" belongs to a capability issue, but the router sends it to haiku (router score 0.12).'));
  const ok = decide(run(0, [['hard', true]], 0.01), run(8, [['hard', true]], 0.001), null, title, { costFirst: true, routing: { ...routing, cases: [routing.cases[1]!] } });
  assert.equal(ok.decision, 'accept');
  assert.ok(ok.reasons.includes('Routing: all 1 capability case goes to sonnet (router score 0.91).'));
});
