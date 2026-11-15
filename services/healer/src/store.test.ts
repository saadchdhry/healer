import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TraceSource } from '@healer/agent';
import { HealerStore } from './store.ts';
import { makeTrace, setupHealer } from './testing.ts';

const dir = mkdtempSync(join(tmpdir(), 'healer-store-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('counts by source include every source, zeros included, and match the rows saved', () => {
  const store = new HealerStore(join(dir, 'healer.db'));
  const saved: Partial<Record<TraceSource, number>> = { shop: 2, seed: 1, eval: 3, replay: 4 };
  for (const [source, n] of Object.entries(saved) as [TraceSource, number][]) {
    for (let i = 0; i < n; i++) store.saveTrace(makeTrace('c_marcus', () => {}, { source }));
  }
  assert.deepEqual(store.traceCountsBySource(), { shop: 2, simulator: 0, seed: 1, eval: 3, redteam: 0, replay: 4 });
  assert.equal(store.traceCount(), 3);
  assert.equal(store.sandboxTraceCount(), 7);
  store.close();
});

test('the counts route is not taken for a trace id', async () => {
  const h = setupHealer(null);
  h.store.saveTrace(makeTrace('c_marcus', () => {}, { source: 'redteam' }));
  const res = await h.call<Record<TraceSource, number>>('GET', '/api/healer/traces/sources');
  assert.equal(res.status, 200);
  assert.equal(res.body.redteam, 1);
  h.close();
  rmSync(h.dir, { recursive: true, force: true });
});
