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
