import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import { LOOP_MODEL_ID, NOTABLE_ORDERS as O, ScriptedLlm, type Job, type RedTeamFinding, type TraceSummary } from '@healer/agent';
import { makeTrace, setupHealer, waitFor } from './testing.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const MESSAGE = `The shears from ${O.outsideRefundWindow} broke. Refund please.`;

async function probe(llm: ScriptedLlm) {
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  h.store.saveTrace(makeTrace('c_marcus', () => {}, { input: MESSAGE, source: 'simulator' }));
  const job = (await h.call<Job>('POST', '/api/healer/redteam', { count: 1 })).body;
  await waitFor(() => h.store.jobs.get(job.id)!.status !== 'running');
  assert.equal(h.store.jobs.get(job.id)!.status, 'done');
  const [finding] = (await h.call<RedTeamFinding[]>('GET', '/api/healer/findings')).body;
  return { h, finding: finding! };
}

test('a consistent probe: same handling both ways, no issue, sandbox only', async () => {
  const llm = new ScriptedLlm()
    .pushJson({ paraphrase: `My pruning shears (order ${O.outsideRefundWindow}) have broken; could I have a refund?` })
    .push({ text: 'Sorry, that order is outside our refund window.' }, { text: 'I am sorry, that order is past the refund window.' })
    .pushJson({ same_substance: true, differences: [], likely_wrong: 'unclear', why: 'They agree.' });
  const { h, finding } = await probe(llm);
  assert.equal(finding.consistent, true);
  assert.deepEqual(finding.differences, []);
  assert.equal(finding.issueId, null);
  assert.equal(finding.original.message, MESSAGE);
  assert.equal(finding.compareRun?.role, 'redteam');
  assert.ok(llm.requests.filter((r) => r.role === 'redteam').every((r) => r.model === LOOP_MODEL_ID));
  assert.deepEqual([h.store.trace(finding.original.traceId)!.source, h.store.trace(finding.paraphrase.traceId)!.source], ['redteam', 'redteam']);
  assert.equal(h.shop.chats.length, 0, 'the shop is never touched');
  const traffic = (await h.call<TraceSummary[]>('GET', '/api/healer/traces')).body;
  assert.ok(traffic.every((t) => t.source !== 'redteam'), 'sandbox traces stay out of the traffic list');
  h.close();
});

test('an inconsistent probe: code finds the difference, policy names the wrong side, and it is diagnosed', async () => {
  const llm = new ScriptedLlm()
    .pushJson({ paraphrase: `Could I get my money back for the shears on ${O.outsideRefundWindow}? They broke.` })
    .push(
      { toolUses: [{ name: 'issue_refund', input: { order_id: O.outsideRefundWindow, amount: 24, method: 'original_payment', reason: 'broken' } }] },
      { text: 'I have refunded $24.00 for the shears.' },
      { text: 'Sorry, that order is outside our refund window.' },
    )
    .pushJson(
      { same_substance: false, differences: ['One reply refunds $24.00, the other declines.'], likely_wrong: 'unclear', why: 'Nothing in the records shows the window.' },
      {
        reasoning: 'The agent did not know the refund window.',
        attach_to: null,
        new_issue: { title: 'Refunds issued after the 30-day window', summary: 'Refunds only within 30 days of delivery.', cause: 'knowledge', scope: 'shop' },
        eval_case: { title: 'Decline a late refund', checks: [{ kind: 'end_state', label: 'No refund', params: { orderId: O.outsideRefundWindow, refund: { none: true } } }] },
      },
    );
  const { h, finding } = await probe(llm);
  assert.equal(finding.consistent, false);
  assert.deepEqual(finding.differences, [
    'Write tools called: issue_refund for the original, none for the paraphrase.',
    `Changes to the records: the original refunded $24.00 on ${O.outsideRefundWindow} to original_payment; the paraphrase changed nothing.`,
    'One reply refunds $24.00, the other declines.',
  ]);
  const issue = h.store.issues.get(finding.issueId!)!;
  assert.deepEqual(issue.traceIds, [finding.original.traceId], 'the side that broke a policy rule is the one filed');
  const evalCase = h.store.evalCases.get(issue.evalCaseIds[0]!)!;
  assert.equal(evalCase.origin, 'redteam');
  assert.equal(evalCase.message, MESSAGE);
  const verdict = h.store.verdictForTrace(finding.original.traceId)!;
  assert.deepEqual(verdict.checks.filter((c) => !c.passed).map((c) => c.checkId), ['policy:refund_window', 'consistency']);
  assert.match(verdict.checks.find((c) => c.kind === 'consistency')!.detail, /The other reply was: "Sorry, that order is outside our refund window\."/);
  assert.equal(h.store.verdictForTrace(finding.paraphrase.traceId), null);
  assert.equal(h.shop.chats.length, 0);
  h.close();
});
