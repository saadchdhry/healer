import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import {
  finishModelRun,
  modelRun,
  NOTABLE_ORDERS as O,
  type AgentVersion,
  type ChatResult,
  type GateRun,
  type Job,
  type JsonResult,
  type LlmClient,
  type LlmContent,
  type LlmRequest,
  type Overview,
  type Proposal,
  type RouterExample,
  type RouterModel,
} from '@healer/agent';
import type { z } from 'zod';
import { JUDGE_SYSTEM } from './judge.ts';
import { assignSplits } from './routerTraining.ts';
import { makeTrace, setupHealer, waitFor } from './testing.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Haiku refunds a late order whenever the message says "late"; sonnet declines. The judge model passes everything,
// so the only failures are the policy rules checked in code.
class TierLlm implements LlmClient {
  async chat(req: LlmRequest): Promise<ChatResult> {
    const last = req.messages.at(-1)!;
    const late = typeof last.content === 'string' && last.content.includes('late') && req.model.includes('haiku');
    const toolUses = late ? [{ id: `toolu_${crypto.randomUUID()}`, name: 'issue_refund', input: { order_id: O.outsideRefundWindow, amount: 24, method: 'original_payment', reason: 'r' } }] : [];
    const text = late ? '' : 'All sorted.';
    const content: LlmContent = toolUses.length ? toolUses.map((t) => ({ type: 'tool_use' as const, ...t })) : [{ type: 'text', text }];
    const run = finishModelRun(modelRun(req, req.role, {}), { content }, req.model, 1000, 100);
    return { stopReason: toolUses.length ? 'tool_use' : 'end_turn', text, toolUses, content, run };
  }

  async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    const ok = { detail: 'Fine.', passed: true };
    const message = req.messages[0]!.content as string;
    const value =
      req.system === JUDGE_SYSTEM
        ? { truthful: ok, grounded: ok, customer_notes: { applicable: false, detail: '', passed: true }, preferences: [{ said: 'call me Mo', note: 'Prefers Mo.' }] }
        : { results: [...message.matchAll(/^- \[(\w+)\]/gm)].map((m) => ({ id: m[1], detail: 'Met.', passed: true })) };
    const parsed = req.schema.parse(value);
    return { value: parsed, run: finishModelRun(modelRun(req, req.role, {}), parsed, req.model, 100, 10) };
  }
}

async function healerWithTraffic(texts: string[]) {
  const h = setupHealer(new TierLlm());
  dirs.push(h.dir);
  h.start();
  await waitFor(() => h.healer.shopConnected && h.store.versions.count() === 1);
  await h.call('PUT', '/api/healer/settings', { trialsPerCase: 1 });
  for (const input of texts) h.store.saveTrace(makeTrace('c_marcus', () => {}, { input, source: 'shop' }));
  return h;
}

async function buildDataset(h: Awaited<ReturnType<typeof healerWithTraffic>>, maxExamples: number): Promise<RouterExample[]> {
  const job = (await h.call<Job>('POST', '/api/healer/model/router/dataset', { maxExamples })).body;
  await waitFor(() => h.store.jobs.get(job.id)!.status !== 'running');
  assert.equal(h.store.jobs.get(job.id)!.status, 'done');
  return h.store.routerDataset();
}

test('splits are deterministic and stratified', () => {
  const ex = (i: number, needsStrong: boolean) => ({ id: `x${i}`, text: `request ${i}`, needsStrong, easyTraceId: '', hardTraceId: '', easyPassed: !needsStrong, hardPassed: true });
  const examples = [...Array.from({ length: 8 }, (_, i) => ex(i, true)), ...Array.from({ length: 12 }, (_, i) => ex(i + 8, false))];
  const a = assignSplits(examples);
  assert.deepEqual(a, assignSplits([...examples].reverse()).reverse());
  assert.equal(a.filter((e) => e.needsStrong && e.split === 'val').length, 2);
  assert.equal(a.filter((e) => !e.needsStrong && e.split === 'val').length, 3);
  assert.ok(assignSplits(examples.slice(5)).filter((e) => e.needsStrong).every((e) => e.split === 'train'), 'too few positives: all train');
});

test('dataset: replays on both tiers label requests the small model fails; train, propose routed, gate, then the tier picker', async () => {
  const late = Array.from({ length: 8 }, (_, i) => `refund my late order please, case ${i}`);
  const easy = Array.from({ length: 8 }, (_, i) => `where is my parcel, case ${i}`);
  const h = await healerWithTraffic([...late, ...easy, late[0]!]);
  h.store.saveTrace(makeTrace('c_marcus', () => {}, { input: 'a follow-up', history: [{ role: 'customer', text: 'hi' }, { role: 'agent', text: 'hello' }] }));
  h.store.saveTrace(makeTrace('c_marcus', () => {}, { input: 'an eval run', source: 'eval' }));

  const dataset = await buildDataset(h, 50);
  assert.equal(dataset.length, 16, 'distinct first messages from traffic only');
  for (const e of dataset) {
    assert.equal(e.needsStrong, e.text.includes('late'));
    assert.deepEqual([e.easyPassed, e.hardPassed], [!e.text.includes('late'), true]);
    assert.equal(h.store.trace(e.easyTraceId)!.tierUsed, 'haiku');
    assert.equal(h.store.trace(e.hardTraceId)!.tierUsed, 'sonnet');
    assert.equal(h.store.trace(e.hardTraceId)!.source, 'replay');
  }
  assert.deepEqual(['train', 'val'].map((s) => dataset.filter((e) => e.split === s && e.needsStrong).length), [6, 2]);
  assert.equal(h.store.issues.count(), 0, 'replays file no preferences');
  const overview = (await h.call<Overview>('GET', '/api/healer/overview')).body;
  assert.deepEqual([overview.counts.verdictsPassed + overview.counts.verdictsFailed, overview.counts.routerExamples, overview.counts.traces], [0, 16, 18]);

  const trained = await h.call<RouterModel>('POST', '/api/healer/model/router/train');
  assert.equal(trained.status, 200);
  assert.equal(trained.body.metrics.trainSize, 12);
  assert.equal(trained.body.metrics.valAccuracy, 1);
  await h.call('POST', '/api/healer/model/router/train');
  assert.equal(h.store.routers().length, 1, 'the same data gives the same weights version');

  const proposal = (await h.call<Proposal>('POST', `/api/healer/model/router/${trained.body.id}/propose`)).body;
  assert.deepEqual([proposal.author, proposal.issueId], ['loop', null]);
  const candidate = h.store.versions.get(proposal.candidateVersionId)!;
  assert.deepEqual({ ...candidate.model, router: undefined }, { mode: 'routed', easyTier: 'haiku', hardTier: 'sonnet', effort: 'low', router: undefined });

  await h.call('POST', `/api/healer/proposals/${proposal.id}/gate`);
  await waitFor(() => h.store.proposals.get(proposal.id)!.status !== 'gating' && h.store.proposals.get(proposal.id)!.gateRunId !== null && h.store.gateRuns.get(h.store.proposals.get(proposal.id)!.gateRunId!)!.decision !== 'pending', 10_000);
  const gate = h.store.gateRuns.get(h.store.proposals.get(proposal.id)!.gateRunId!) as GateRun;
  assert.equal(gate.decision, 'accept');
  assert.match(gate.reasons[0]!, /^Accepted: cost per task goes from \$\d\.\d{4} on version 0 to \$\d\.\d{4} on version 1/);
  assert.match(gate.reasons[1]!, /^Pass rate: .+ \(no change\)\.$/);

  const live = await h.call<AgentVersion>('POST', `/api/healer/proposals/${proposal.id}/approve`);
  assert.equal(h.shop.deployed.model.mode, 'routed');
  const picked = await h.call<AgentVersion>('POST', '/api/healer/model/tier', { tier: 'opus' });
  assert.equal(picked.status, 200);
  assert.deepEqual(picked.body.model, { mode: 'fixed', tier: 'opus', effort: 'low' });
  assert.equal(picked.body.parentId, live.body.id);
  h.close();
});

test('training without any request that needed the strong model is a conflict', async () => {
  const h = await healerWithTraffic(['where is my parcel', 'hello there']);
  const empty = await h.call<{ error: string; message: string }>('POST', '/api/healer/model/router/train');
  assert.equal(empty.status, 409);
  assert.equal((await buildDataset(h, 10)).length, 2);
  const res = await h.call<{ error: string; message: string }>('POST', '/api/healer/model/router/train');
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'conflict');
  assert.match(res.body.message, /no requests that needed the stronger model yet/);
  assert.equal((await h.call('POST', '/api/healer/model/router/nope/propose')).status, 404);
  h.close();
});
