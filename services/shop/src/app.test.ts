import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { factoryVersion, NOTABLE_ORDERS, ScriptedLlm, type AgentVersion, type EnvSnapshot, type LlmClient, type ShopEvent, type ThreadView } from '@healer/agent';
import { createShopApp } from './app.ts';

const dir = mkdtempSync(join(tmpdir(), 'shop-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function setup(llm: LlmClient | null) {
  const shop = createShopApp({ dbPath: join(dir, `${crypto.randomUUID()}.db`), getLlm: () => llm });
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await shop.app.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { ...shop, call };
}

test('chat, feedback, events and threads', async () => {
  const llm = new ScriptedLlm([
    { toolUses: [{ name: 'issue_refund', input: { order_id: NOTABLE_ORDERS.cleanRefund, amount: 10, method: 'store_credit', reason: 'r' } }] },
    { text: 'Refunded!' },
    { text: 'You are welcome.' },
  ]);
  const { call, close } = setup(llm);

  const customers = await call<{ id: string }[]>('GET', '/api/shop/customers');
  assert.equal(customers.body.length, 6);
  const orders = await call<{ customerId: string }[]>('GET', '/api/shop/customers/c_ava/orders');
  assert.ok(orders.body.every((o) => o.customerId === 'c_ava'));

  const first = await call<{ threadId: string; traceId: string; reply: string }>('POST', '/api/shop/chat', { customerId: 'c_ava', message: 'Refund please' });
  assert.equal(first.status, 200);
  assert.equal(first.body.reply, 'Refunded!');
  const env = await call<EnvSnapshot>('GET', '/api/shop/env');
  assert.equal(env.body.refunds.length, 2);

  const second = await call<{ threadId: string }>('POST', '/api/shop/chat', { customerId: 'c_ava', threadId: first.body.threadId, message: 'Thanks' });
  assert.equal(second.body.threadId, first.body.threadId);
  assert.deepEqual(llm.requests[2]!.messages.map((m) => m.role), ['user', 'assistant', 'user']);

  assert.equal((await call('POST', '/api/shop/feedback', { traceId: first.body.traceId, rating: 'down' })).status, 200);
  assert.equal((await call('POST', '/api/shop/feedback', { traceId: 'nope', rating: 'up' })).status, 404);

  const threads = await call<ThreadView[]>('GET', '/api/shop/customers/c_ava/threads');
  assert.equal(threads.body.length, 1);
  assert.equal(threads.body[0]!.turns.length, 4);
  assert.equal(threads.body[0]!.turns[1]!.rating, 'down');
  assert.equal(threads.body[0]!.turns[0]!.rating, null);

  const all = await call<ShopEvent[]>('GET', '/api/shop/events');
  assert.deepEqual(all.body.map((e) => e.type), ['trace.started', 'trace.completed', 'trace.started', 'trace.completed', 'feedback']);
  const completed = all.body[1]!;
  assert.ok(completed.type === 'trace.completed' && completed.trace.id === first.body.traceId && completed.trace.toolCalls.length === 1);
  const later = await call<ShopEvent[]>('GET', `/api/shop/events?after=${all.body[2]!.seq}`);
  assert.deepEqual(later.body.map((e) => e.type), ['trace.completed', 'feedback']);
  close();
});

test('chat validates input, needs a key, and survives agent failure', async () => {
  assert.equal((await setup(null).call('POST', '/api/shop/chat', { customerId: 'c_ava', message: 'hi' })).status, 503);
  const { call, close } = setup(new ScriptedLlm([]));
  assert.equal((await call('POST', '/api/shop/chat', { customerId: 'c_ava' })).status, 400);
  assert.equal((await call('POST', '/api/shop/chat', { customerId: 'nobody', message: 'hi' })).status, 404);
  assert.equal((await call('POST', '/api/shop/chat', { customerId: 'c_ava', threadId: 'th_missing', message: 'hi' })).status, 404);
  const failed = await call<{ error: string; message: string }>('POST', '/api/shop/chat', { customerId: 'c_ava', message: 'hi' });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, 'agent_failed');
  assert.deepEqual((await call<ThreadView[]>('GET', '/api/shop/customers/c_ava/threads')).body, []);
  close();
});

test('deployment swap and reset', async () => {
  const llm = new ScriptedLlm([
    { toolUses: [{ name: 'cancel_order', input: { order_id: NOTABLE_ORDERS.processing } }] },
    { text: 'Cancelled.' },
  ]);
  const { call, close } = setup(llm);
  const v1: AgentVersion = { ...factoryVersion(), id: 1, parentId: 0, author: 'human', model: { mode: 'fixed', tier: 'sonnet', effort: 'medium' } };
  assert.equal((await call('PUT', '/api/shop/deployment', { nope: true })).status, 400);
  assert.equal((await call('PUT', '/api/shop/deployment', v1)).status, 200);
  assert.equal((await call<AgentVersion>('GET', '/api/shop/deployment')).body.id, 1);

  await call('POST', '/api/shop/chat', { customerId: 'c_ava', message: 'Cancel my order' });
  assert.equal(llm.requests[0]!.model, 'claude-sonnet-5-5');
  const changed = await call<EnvSnapshot>('GET', '/api/shop/env');
  assert.equal(changed.body.orders.find((o) => o.id === NOTABLE_ORDERS.processing)!.status, 'cancelled');
  const before = await call<ShopEvent[]>('GET', '/api/shop/events');
  assert.equal(before.body[0]!.type, 'deployment');

  assert.equal((await call('POST', '/api/shop/reset')).status, 200);
  assert.equal((await call<AgentVersion>('GET', '/api/shop/deployment')).body.id, 0);
  const env = await call<EnvSnapshot>('GET', '/api/shop/env');
  assert.equal(env.body.orders.find((o) => o.id === NOTABLE_ORDERS.processing)!.status, 'processing');
  assert.deepEqual((await call<ThreadView[]>('GET', '/api/shop/customers/c_ava/threads')).body, []);
  const events = await call<ShopEvent[]>('GET', '/api/shop/events');
  assert.deepEqual(events.body.map((e) => e.type), ['reset']);
  assert.ok(events.body[0]!.seq > before.body.at(-1)!.seq);
  close();
});
