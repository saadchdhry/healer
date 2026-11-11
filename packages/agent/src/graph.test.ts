import assert from 'node:assert/strict';
import { test } from 'node:test';
import { END, Graph } from './graph.ts';
import type { Run } from './types.ts';

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
