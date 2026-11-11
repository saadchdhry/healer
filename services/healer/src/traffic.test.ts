import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { rmSync } from 'node:fs';
import { NOTABLE_ORDERS, ScriptedLlm, SIMULATOR_MODEL_ID, seedSnapshot, type Job, type SeededCase } from '@healer/agent';
import { SIMULATOR_SYSTEM } from './simulate.ts';
import { setupHealer, waitFor } from './testing.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function finished(h: ReturnType<typeof setupHealer>, job: Job): Promise<Job> {
  await waitFor(() => h.store.jobs.get(job.id)!.status !== 'running');
  return h.store.jobs.get(job.id)!;
}

test('seeded cases: a library tied to seed customers and notable orders, written without em dashes', async () => {
  const h = setupHealer(new ScriptedLlm());
  dirs.push(h.dir);
  const seeds = (await h.call<SeededCase[]>('GET', '/api/healer/seeds')).body;
  assert.ok(seeds.length >= 12);
  const customers = new Set(seedSnapshot().customers.map((c) => c.id));
  for (const s of seeds) {
    assert.ok(customers.has(s.customerId), s.id);
    assert.ok(s.teaches.length > 20 && s.messages.length >= 1, s.id);
    assert.ok(![s.title, s.teaches, ...s.messages].some((t) => t.includes('—')), `${s.id} has an em dash`);
  }
  assert.ok(seeds.some((s) => s.messages[0]!.includes(NOTABLE_ORDERS.multiRule)));
  assert.equal(new Set(seeds.map((s) => s.id)).size, seeds.length);
  assert.equal((await h.call('POST', '/api/healer/seeds/nope/fire')).status, 404);
  h.close();
});

test('firing a seeded case sends its messages in order, in one thread, as that customer', async () => {
  const h = setupHealer(new ScriptedLlm());
  dirs.push(h.dir);
  const seed = (await h.call<SeededCase[]>('GET', '/api/healer/seeds')).body.find((s) => s.messages.length > 1)!;
  const job = await finished(h, (await h.call<Job>('POST', `/api/healer/seeds/${seed.id}/fire`)).body);
  assert.equal(job.status, 'done');
  assert.deepEqual(job.progress, { done: seed.messages.length, total: seed.messages.length });
  assert.deepEqual(h.shop.chats.map((c) => c.message), seed.messages);
  assert.ok(h.shop.chats.every((c) => c.source === 'seed' && c.customerId === seed.customerId && c.threadId === h.shop.chats[0]!.threadId));
  h.close();
});

test('the simulator answers a question once, then stops at two customer turns', async () => {
  const llm = new ScriptedLlm().pushJson({ message: 'hi, where are my pots' }, { reply: 'the terracotta ones' });
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.shop.reply = () => 'Which order do you mean?';
  const job = await finished(h, (await h.call<Job>('POST', '/api/healer/simulate', { count: 1 })).body);
  assert.equal(job.status, 'done');
  assert.deepEqual(job.progress, { done: 1, total: 1 });
  assert.deepEqual(h.shop.chats.map((c) => c.message), ['hi, where are my pots', 'the terracotta ones']);
  assert.ok(h.shop.chats.every((c) => c.source === 'simulator' && c.threadId === h.shop.chats[0]!.threadId));
  assert.equal(llm.requests.length, 2, 'no third customer turn is written');
  assert.ok(llm.requests.every((r) => r.role === 'simulator' && r.model === SIMULATOR_MODEL_ID && r.system === SIMULATOR_SYSTEM));
  const brief = llm.requests[0]!.messages[0]!.content as string;
  assert.match(brief, /What you want: .+\n\nVoice: .+/);
  assert.match(llm.requests[1]!.messages[0]!.content as string, /Agent: Which order do you mean\?/);
  assert.match(h.store.activity.list().at(-1)!.text, /^Simulated customer 1 of 1: .+, 2 messages$/);
  h.close();
});

test('the simulator does not reply when the agent asks nothing', async () => {
  const llm = new ScriptedLlm().pushJson({ message: 'please cancel my order' });
  const h = setupHealer(llm);
  dirs.push(h.dir);
  h.shop.reply = () => 'Done, it is cancelled.';
  await finished(h, (await h.call<Job>('POST', '/api/healer/simulate', { count: 1 })).body);
  assert.equal(h.shop.chats.length, 1);
  assert.equal(llm.requests.length, 1);
  assert.equal((await h.call('POST', '/api/healer/simulate', { count: 101 })).status, 400);
  h.close();
});
