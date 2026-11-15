import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Environment, NOTABLE_ORDERS, seedSnapshot } from './env.ts';
import { END, Graph, traceRoute, type RouteStep } from './graph.ts';
import { agentGraphShape, factoryVersion, runAgent } from './supportAgent.ts';
import { ScriptedLlm, type ScriptedTurn } from './testing.ts';
import type { AgentVersion, Run } from './types.ts';

function counter() {
  return new Graph<{ n: number; path: string[] }>('counter', 'start')
    .node('start', 'Start', 'Begin', (s) => void s.path.push('start'))
    .node('inc', 'Increment', 'Add one', (s) => {
      s.n++;
      s.path.push('inc');
      return { n: s.n };
    })
    .node('done', 'Done', 'Stop', (s) => void s.path.push('done'))
    .edge('start', 'inc')
    .branch('inc', [{ to: 'inc', label: 'again' }, { to: 'done', label: 'enough' }], (s) => (s.n < 3 ? 'inc' : 'done'))
    .edge('done', END);
}

test('conditional edges loop until the condition flips and emit one node run per step', async () => {
  const runs: Run[] = [];
  const state = await counter().run({ n: 0, path: [] }, { maxSteps: 10, onRun: (r) => runs.push(r) });
  assert.deepEqual(state.path, ['start', 'inc', 'inc', 'inc', 'done']);
  assert.equal(runs.length, 5);
  assert.ok(runs.every((r) => r.kind === 'node' && r.parentId === null && r.endedAt));
  assert.deepEqual(runs[3]!.output, { n: 3 });
});

test('the step limit stops a runaway graph', async () => {
  await assert.rejects(counter().run({ n: 0, path: [] }, { maxSteps: 3 }), /exceeded 3 steps/);
});

test('shape lists nodes, labelled edges and the entry', () => {
  const shape = counter().shape();
  assert.equal(shape.entry, 'start');
  assert.deepEqual(shape.nodes.map((n) => n.id), ['start', 'inc', 'done']);
  assert.deepEqual(shape.edges, [
    { from: 'start', to: 'inc' },
    { from: 'inc', to: 'inc', label: 'again' },
    { from: 'inc', to: 'done', label: 'enough' },
    { from: 'done', to: END },
  ]);
});

test('a node error is recorded on its run and rethrown', async () => {
  const runs: Run[] = [];
  const g = new Graph<object>('boom', 'a').node('a', 'A', 'Fails', () => {
    throw new Error('nope');
  });
  await assert.rejects(g.run({}, { maxSteps: 5, parentId: 'p1', onRun: (r) => runs.push(r) }), /nope/);
  assert.equal(runs[0]!.error, 'nope');
  assert.equal(runs[0]!.parentId, 'p1');
});

async function route(turns: ScriptedTurn[], version: AgentVersion = factoryVersion()) {
  const trace = await runAgent({
    version,
    env: new Environment(seedSnapshot()),
    customerId: 'c_ava',
    history: [],
    message: 'Where is my order?',
    threadId: 'th_1',
    source: 'eval',
    llm: new ScriptedLlm(turns),
  });
  return traceRoute(trace, agentGraphShape);
}

const show = (steps: RouteStep[]) =>
  steps.map((s) => (s.kind === 'edge' ? `${s.n} ${s.from} > ${s.to}${s.label ? ` (${s.label})` : ''}` : `${s.n} tool ${s.name}${s.blocked ? ' blocked' : ''}`));

test('a reply with no tool calls goes straight through to finish', async () => {
  assert.deepEqual(show(await route([{ text: 'Hello.' }])), [
    '1 route > assemble_context',
    '2 assemble_context > call_model',
    '3 call_model > finish (final reply)',
    `4 finish > ${END}`,
  ]);
});

test('one lookup and a reply numbers the tool call between the moves into and out of run_tools', async () => {
  const steps = await route([{ toolUses: [{ name: 'list_orders', input: {} }] }, { text: 'Your order is on its way.' }]);
  assert.deepEqual(show(steps), [
    '1 route > assemble_context',
    '2 assemble_context > call_model',
    '3 call_model > run_tools (tool calls)',
    '4 tool list_orders',
    '5 run_tools > call_model (steps left)',
    '6 call_model > finish (final reply)',
    `7 finish > ${END}`,
  ]);
});

test('two laps of the loop give the repeated edges both numbers', async () => {
  const steps = await route([
    { toolUses: [{ name: 'list_orders', input: {} }] },
    { toolUses: [{ name: 'get_order', input: { order_id: NOTABLE_ORDERS.cleanRefund } }] },
    { text: 'Found it.' },
  ]);
  const numbers = (from: string, to: string) => steps.filter((s) => s.kind === 'edge' && s.from === from && s.to === to).map((s) => s.n);
  assert.deepEqual(numbers('call_model', 'run_tools'), [3, 6]);
  assert.deepEqual(numbers('run_tools', 'call_model'), [5, 8]);
  assert.deepEqual(
    steps.filter((s) => s.kind === 'tool').map((s) => [s.n, s.name]),
    [
      [4, 'list_orders'],
      [7, 'get_order'],
    ],
  );
  assert.deepEqual(steps.map((s) => s.n), steps.map((_, i) => i + 1));
});

test('a call blocked by a guard is marked blocked and the next call is not', async () => {
  const version = factoryVersion();
  version.harness.guards.refundEscalationThreshold = 50;
  const steps = await route(
    [
      { toolUses: [{ name: 'issue_refund', input: { order_id: NOTABLE_ORDERS.cleanRefund, amount: 64.95, method: 'original_payment', reason: 'Broken' } }] },
      { toolUses: [{ name: 'escalate_to_human', input: { reason: 'Refund above the limit' } }] },
      { text: 'A colleague will be in touch.' },
    ],
    version,
  );
  assert.deepEqual(
    steps.filter((s) => s.kind === 'tool'),
    [
      { n: 4, kind: 'tool', name: 'issue_refund', blocked: true },
      { n: 7, kind: 'tool', name: 'escalate_to_human', blocked: false },
    ],
  );
});

test('a trace that hits the step limit leaves run_tools by the step limit branch', async () => {
  const version = factoryVersion();
  version.harness.maxSteps = 3;
  const loop = { toolUses: [{ name: 'list_orders', input: {} }] };
  const steps = await route([loop, loop, loop], version);
  const edges = steps.filter((s) => s.kind === 'edge');
  assert.equal(edges.filter((s) => s.from === 'call_model' && s.to === 'run_tools').length, 3);
  assert.equal(edges.filter((s) => s.from === 'run_tools' && s.to === 'call_model').length, 2);
  assert.deepEqual(show(steps.slice(-2)), ['11 run_tools > finish (step limit)', `12 finish > ${END}`]);
});
