import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Environment, NOTABLE_ORDERS, seedSnapshot } from './env.ts';
import { trainRouter } from './router.ts';
import { agentGraphShape, factoryVersion, lookedUpOrderIds, runAgent, STEP_LIMIT_REPLY } from './supportAgent.ts';
import { ScriptedLlm } from './testing.ts';
import type { AgentVersion, Run } from './types.ts';

function input(llm: ScriptedLlm, version: AgentVersion = factoryVersion()) {
  return {
    version,
    env: new Environment(seedSnapshot()),
    customerId: 'c_ava',
    history: [
      { role: 'customer' as const, text: 'Hi there' },
      { role: 'agent' as const, text: 'Hello! How can I help?' },
    ],
    message: 'Please refund my watering can order.',
    threadId: 'th_1',
    source: 'eval' as const,
    llm,
  };
}

test('factory version is the deliberately under-informed start', () => {
  const v = factoryVersion();
  assert.equal(v.id, 0);
  assert.equal(v.status, 'live');
  assert.equal(v.author, 'factory');
  assert.deepEqual(v.model, { mode: 'fixed', tier: 'haiku', effort: 'low' });
  assert.equal(v.harness.tools.length, 6);
  assert.ok(v.harness.tools.every((t) => t.enabled));
  assert.deepEqual(v.harness.guards, { requireOrderLookupBeforeWrite: false, blockDuplicateRefund: false, refundEscalationThreshold: null });
  assert.doesNotMatch(v.harness.systemPrompt, /refund|30|window|final sale/i);
  assert.ok(!v.harness.systemPrompt.includes(String.fromCharCode(0x2014)));
});

test('agent graph shape matches the nodes the code runs', () => {
  assert.equal(agentGraphShape.entry, 'route');
  assert.deepEqual(agentGraphShape.nodes.map((n) => n.id), ['route', 'assemble_context', 'call_model', 'run_tools', 'finish']);
});

test('runAgent produces a complete, well-nested trace', async () => {
  const llm = new ScriptedLlm([
    { text: 'Let me check.', toolUses: [{ name: 'get_order', input: { order_id: NOTABLE_ORDERS.cleanRefund } }] },
    { toolUses: [{ name: 'issue_refund', input: { order_id: NOTABLE_ORDERS.cleanRefund, amount: 64.95, method: 'original_payment', reason: 'Customer request' } }] },
    { text: 'Done, your refund is on its way.' },
  ]);
  const version = factoryVersion();
  version.context = [
    { id: 'n1', scope: { kind: 'shop' }, text: 'Refunds within 30 days only.', addedInVersion: 1, issueId: null },
    { id: 'n2', scope: { kind: 'customer', customerId: 'c_ava' }, text: 'Prefers store credit.', addedInVersion: 1, issueId: null },
    { id: 'n3', scope: { kind: 'customer', customerId: 'c_tom' }, text: 'Not for Ava.', addedInVersion: 1, issueId: null },
  ];
  const seen: Run[] = [];
  const trace = await runAgent({ ...input(llm, version), traceId: 'tr_1', onRun: (r) => seen.push(r) });

  assert.equal(trace.error, undefined);
  assert.equal(trace.id, 'tr_1');
  assert.equal(trace.output, 'Done, your refund is on its way.');
  assert.equal(trace.tierUsed, 'haiku');
  assert.equal(trace.routerDecision, null);
  assert.deepEqual(trace.toolCalls.map((t) => t.name), ['get_order', 'issue_refund']);
  assert.equal(trace.envBefore.refunds.length, 1);
  assert.equal(trace.envAfter.refunds.length, 2);
  assert.deepEqual(seen, trace.runs);

  const nodes = trace.runs.filter((r) => r.kind === 'node');
  assert.deepEqual(nodes.map((r) => r.name), ['route', 'assemble_context', 'call_model', 'run_tools', 'call_model', 'run_tools', 'call_model', 'finish']);
  const byId = new Map(trace.runs.map((r) => [r.id, r]));
  for (const r of trace.runs.filter((r) => r.kind !== 'node')) {
    const parent = byId.get(r.parentId!)!;
    assert.equal(parent.name, r.kind === 'model' ? 'call_model' : 'run_tools');
  }
  const models = trace.runs.filter((r) => r.kind === 'model');
  assert.equal(models.length, 3);
  assert.ok(models.every((r) => r.role === 'agent' && r.model === 'claude-haiku-5-5'));
  assert.equal(trace.usage.inputTokens, 3000);
  assert.ok(Math.abs(trace.usage.costUsd - models.reduce((n, r) => n + r.usage!.costUsd, 0)) < 1e-12);

  const system = llm.requests[0]!.system;
  assert.ok(system.startsWith(version.harness.systemPrompt));
  assert.match(system, /Shop notes:\n- Refunds within 30 days only\./);
  assert.match(system, /Prefers store credit/);
  assert.doesNotMatch(system, /Not for Ava/);
  assert.match(system, /2026-11-11/);
  assert.match(system, /Ava Thompson/);
  assert.deepEqual(llm.requests[0]!.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(llm.requests[2]!.messages.length, 7);
});

test('a guard refusal is recorded on the tool call', async () => {
  const llm = new ScriptedLlm([
    { toolUses: [{ name: 'cancel_order', input: { order_id: NOTABLE_ORDERS.processing } }] },
    { text: 'Sorry, I could not do that.' },
  ]);
  const version = factoryVersion();
  version.harness.guards.requireOrderLookupBeforeWrite = true;
  const trace = await runAgent(input(llm, version));
  assert.equal(trace.toolCalls[0]!.blockedByGuard, 'requireOrderLookupBeforeWrite');
  assert.equal(trace.envAfter.orders.find((o) => o.id === NOTABLE_ORDERS.processing)!.status, 'processing');
  assert.ok(trace.runs.find((r) => r.kind === 'tool')!.error);
});

test('lookups from earlier traces in the thread satisfy the lookup guard', async () => {
  const first = await runAgent(input(new ScriptedLlm([{ toolUses: [{ name: 'list_orders', input: {} }] }, { text: 'Here they are.' }])));
  const ids = lookedUpOrderIds([first]);
  assert.ok(ids.includes(NOTABLE_ORDERS.processing));
  const version = factoryVersion();
  version.harness.guards.requireOrderLookupBeforeWrite = true;
  const llm = new ScriptedLlm([{ toolUses: [{ name: 'cancel_order', input: { order_id: NOTABLE_ORDERS.processing } }] }, { text: 'Cancelled.' }]);
  const trace = await runAgent({ ...input(llm, version), lookedUpOrderIds: ids });
  assert.equal(trace.toolCalls[0]!.blockedByGuard, null);
});

test('the step limit ends the loop with a fallback reply', async () => {
  const version = factoryVersion();
  version.harness.maxSteps = 2;
  const loop = { toolUses: [{ name: 'list_orders', input: {} }] };
  const trace = await runAgent(input(new ScriptedLlm([loop, loop, loop]), version));
  assert.equal(trace.output, STEP_LIMIT_REPLY);
  assert.equal(trace.runs.filter((r) => r.kind === 'model').length, 2);
});

test('a routed model asks the router and records its decision', async () => {
  const router = trainRouter([
    { id: 'a', text: 'refund discount opened', needsStrong: true, reason: 'measured_failure', split: 'train', easyTraceId: '', hardTraceId: '', easyPassed: false, hardPassed: true },
    { id: 'b', text: 'where is my parcel', needsStrong: false, reason: null, split: 'train', easyTraceId: '', hardTraceId: '', easyPassed: true, hardPassed: true },
  ]);
  const version = factoryVersion();
  version.model = { mode: 'routed', easyTier: 'haiku', hardTier: 'opus', effort: 'low', router };
  const llm = new ScriptedLlm([{ text: 'Sure.' }]);
  const trace = await runAgent(input(llm, version));
  assert.equal(trace.routerDecision!.needsStrong, true);
  assert.equal(trace.tierUsed, 'opus');
  assert.equal(llm.requests[0]!.model, 'claude-opus-5-5');
});

test('a failing model call is returned as a trace error, not thrown', async () => {
  const trace = await runAgent(input(new ScriptedLlm([])));
  assert.match(trace.error!, /no scripted turn/);
  assert.equal(trace.output, '');
});
