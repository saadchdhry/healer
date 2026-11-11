import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  Environment,
  factoryVersion,
  lookedUpOrderIds,
  runAgent,
  seedSnapshot,
  type AgentVersion,
  type LlmClient,
  type Rating,
  type ShopApi,
  type ShopEvent,
  type ThreadView,
  type TraceSource,
} from '@healer/agent';
import { ShopStore, type NewShopEvent, type StoredThread } from './store.ts';

type Res<K extends keyof ShopApi> = ShopApi[K]['res'];

export interface ShopOptions {
  dbPath: string;
  // Called per chat, so a key added to the environment later is picked up. Null means no key.
  getLlm: () => LlmClient | null;
  keepAliveMs?: number;
}

const SOURCES: TraceSource[] = ['shop', 'simulator', 'seed', 'eval', 'redteam', 'replay'];
const RATINGS: Rating[] = ['up', 'down'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isAgentVersion(v: unknown): v is AgentVersion {
  if (!isObject(v) || typeof v.id !== 'number' || !Array.isArray(v.context)) return false;
  const { harness, model } = v;
  return (
    isObject(harness) &&
    typeof harness.systemPrompt === 'string' &&
    Array.isArray(harness.tools) &&
    isObject(harness.guards) &&
    typeof harness.maxSteps === 'number' &&
    isObject(model) &&
    (model.mode === 'fixed' || model.mode === 'routed')
  );
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function createShopApp(options: ShopOptions) {
  const store = new ShopStore(options.dbPath);
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  const emit = (event: NewShopEvent): ShopEvent => {
    const stored = store.appendEvent(event);
    bus.emit('event', stored);
    return stored;
  };

  const restoreFactory = () => {
    store.setEnv(seedSnapshot());
    store.setDeployment(factoryVersion());
  };
  if (!store.env() || !store.deployment()) restoreFactory();

  // Chats run one at a time so two never mutate the environment at once.
  let queue: Promise<unknown> = Promise.resolve();
  const serialised = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const threadView = (t: StoredThread): ThreadView => ({
    id: t.id,
    customerId: t.customerId,
    turns: t.turns.map((turn) => ({ ...turn, rating: turn.role === 'agent' && turn.traceId ? store.rating(turn.traceId) : null })),
  });

  const app = new Hono();

  app.get('/api/shop/customers', (c) => c.json<Res<'GET /api/shop/customers'>>(store.env()!.customers));

  app.get('/api/shop/customers/:id/orders', (c) => {
    const env = new Environment(store.env()!);
    if (!env.customer(c.req.param('id'))) return c.json({ error: 'unknown_customer', message: `No customer with id ${c.req.param('id')}` }, 404);
    return c.json<Res<'GET /api/shop/customers/:id/orders'>>(env.ordersFor(c.req.param('id')));
  });

  app.get('/api/shop/customers/:id/threads', (c) =>
    c.json<Res<'GET /api/shop/customers/:id/threads'>>(store.threadsFor(c.req.param('id')).map(threadView)),
  );

  app.post('/api/shop/chat', async (c) => {
    const body = await readJson(c.req.raw);
    if (!isObject(body) || typeof body.customerId !== 'string' || typeof body.message !== 'string' || !body.message.trim()) {
      return c.json({ error: 'bad_request', message: 'customerId and a non-empty message are required' }, 400);
    }
    if (body.threadId !== undefined && typeof body.threadId !== 'string') return c.json({ error: 'bad_request', message: 'threadId must be a string' }, 400);
    if (body.source !== undefined && !SOURCES.includes(body.source as TraceSource)) return c.json({ error: 'bad_request', message: 'unknown source' }, 400);
    const { customerId, message } = body;
    const source = (body.source as TraceSource | undefined) ?? 'shop';
    if (!store.env()!.customers.some((cu) => cu.id === customerId)) return c.json({ error: 'unknown_customer', message: `No customer with id ${customerId}` }, 404);
    const existing = typeof body.threadId === 'string' ? store.thread(body.threadId) : null;
    if (body.threadId !== undefined && (!existing || existing.customerId !== customerId)) return c.json({ error: 'unknown_thread', message: 'That conversation does not exist for this customer' }, 404);
    const llm = options.getLlm();
    if (!llm) return c.json({ error: 'missing_api_key', message: 'No ANTHROPIC_API_KEY is set, so the support agent cannot reply' }, 503);

    return serialised(async () => {
      const thread: StoredThread = existing ? store.thread(existing.id)! : { id: `th_${crypto.randomUUID()}`, customerId, turns: [] };
      const traceId = `tr_${crypto.randomUUID()}`;
      emit({ type: 'trace.started', traceId, threadId: thread.id, customerId, source, message });
      const trace = await runAgent({
        version: store.deployment()!,
        env: new Environment(store.env()!),
        customerId,
        history: thread.turns.map(({ role, text }) => ({ role, text })),
        message,
        threadId: thread.id,
        source,
        llm,
        traceId,
        lookedUpOrderIds: lookedUpOrderIds(store.tracesForThread(thread.id)),
      });
      if (trace.error) {
        emit({ type: 'trace.completed', trace });
        return c.json({ error: 'agent_failed', message: trace.error }, 500);
      }
      const at = trace.endedAt;
      thread.turns.push({ role: 'customer', text: message, traceId, at: trace.startedAt }, { role: 'agent', text: trace.output, traceId, at });
      store.transaction(() => {
        store.setEnv(trace.envAfter);
        store.saveThread(thread);
        store.saveTrace(trace);
      });
      emit({ type: 'trace.completed', trace });
      return c.json<Res<'POST /api/shop/chat'>>({ threadId: thread.id, traceId, reply: trace.output });
    });
  });

  app.post('/api/shop/feedback', async (c) => {
    const body = await readJson(c.req.raw);
    if (!isObject(body) || typeof body.traceId !== 'string' || !RATINGS.includes(body.rating as Rating)) {
      return c.json({ error: 'bad_request', message: 'traceId and rating (up or down) are required' }, 400);
    }
    if (!store.trace(body.traceId)) return c.json({ error: 'unknown_trace', message: 'That reply is no longer on record' }, 404);
    store.setRating(body.traceId, body.rating as Rating);
    emit({ type: 'feedback', traceId: body.traceId, rating: body.rating as Rating });
    return c.json<Res<'POST /api/shop/feedback'>>({ ok: true });
  });

  app.get('/api/shop/events', (c) => {
    const after = Number(c.req.query('after') ?? 0);
    if (!Number.isFinite(after)) return c.json({ error: 'bad_request', message: 'after must be a number' }, 400);
    return c.json<Res<'GET /api/shop/events'>>(store.eventsAfter(after));
  });

  app.get('/api/shop/events/stream', (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: ShopEvent) => void stream.writeSSE({ data: JSON.stringify(event), id: String(event.seq) });
      bus.on('event', send);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n'), options.keepAliveMs ?? 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepAlive);
      bus.off('event', send);
    }),
  );

  app.get('/api/shop/deployment', (c) => c.json<Res<'GET /api/shop/deployment'>>(store.deployment()!));

  app.put('/api/shop/deployment', async (c) => {
    const body = await readJson(c.req.raw);
    if (!isAgentVersion(body)) return c.json({ error: 'bad_request', message: 'body must be an AgentVersion' }, 400);
    await serialised(async () => store.setDeployment(body));
    emit({ type: 'deployment', versionId: body.id });
    return c.json<Res<'PUT /api/shop/deployment'>>({ ok: true });
  });

  app.get('/api/shop/env', (c) => c.json<Res<'GET /api/shop/env'>>(store.env()!));

  app.post('/api/shop/reset', async (c) => {
    await serialised(async () =>
      store.transaction(() => {
        store.clearHistory();
        restoreFactory();
      }),
    );
    emit({ type: 'reset' });
    return c.json<Res<'POST /api/shop/reset'>>({ ok: true });
  });

  return { app, close: () => store.close() };
}
