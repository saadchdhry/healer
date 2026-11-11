import type { AgentVersion, Customer, EnvSnapshot, ShopApi, ShopEvent } from '@healer/agent';
import type { Healer } from './console.ts';
import { runLoop } from './loop.ts';

// Everything the healer needs from the shop, over the shop's public HTTP API. Tests pass a fake.
export interface ShopClient {
  customers(): Promise<Customer[]>;
  deployment(): Promise<AgentVersion>;
  deploy(version: AgentVersion): Promise<void>;
  events(after: number): Promise<ShopEvent[]>;
  // Resolves `opened` once the stream is connected; the returned promise settles when the stream ends.
  stream(onEvent: (event: ShopEvent) => void, opened: () => void, signal: AbortSignal): Promise<void>;
  reset(): Promise<void>;
  env(): Promise<EnvSnapshot>;
  // Sends one customer message through the shop's own chat, exactly as the shop front does.
  chat(input: ShopApi['POST /api/shop/chat']['body']): Promise<ShopApi['POST /api/shop/chat']['res']>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkEvent(v: unknown): ShopEvent {
  if (!isObject(v) || typeof v.seq !== 'number' || typeof v.type !== 'string') throw new Error('The shop sent a malformed event');
  if (v.type === 'trace.completed' && !(isObject(v.trace) && typeof v.trace.id === 'string' && Array.isArray(v.trace.toolCalls))) {
    throw new Error('The shop sent a trace.completed event without a trace');
  }
  return v as ShopEvent;
}

export function httpShopClient(baseUrl: string): ShopClient {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    if (!res.ok) throw new Error(`Shop ${method} ${path} answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  };

  return {
    customers: () => call<Customer[]>('GET', '/api/shop/customers'),
    deployment: () => call<AgentVersion>('GET', '/api/shop/deployment'),
    deploy: async (version) => void (await call('PUT', '/api/shop/deployment', version)),
    events: async (after) => {
      const events = await call<unknown>('GET', `/api/shop/events?after=${after}`);
      if (!Array.isArray(events)) throw new Error('The shop sent a malformed event list');
      return events.map(checkEvent);
    },
    reset: async () => void (await call('POST', '/api/shop/reset')),
    env: () => call<EnvSnapshot>('GET', '/api/shop/env'),
    chat: (input) => call('POST', '/api/shop/chat', input),
    stream: async (onEvent, opened, signal) => {
      const res = await fetch(`${baseUrl}/api/shop/events/stream`, { signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`Shop event stream answered ${res.status}`);
      opened();
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) onEvent(checkEvent(JSON.parse(data)));
        }
      }
    },
  };
}

export interface ShopFollower {
  start(): void;
  stop(): void;
  // Runs `fn` between two events, so nothing is ingested while it runs.
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

// Catches up on missed events, then follows the live stream, reconnecting with backoff.
export function followShop(options: {
  shop: ShopClient;
  cursor: () => number;
  handle: (event: ShopEvent) => Promise<void>;
  setConnected: (connected: boolean) => void;
  // Called on every connection, after the stream opens and before catching up.
  onOpen?: () => Promise<void>;
  onError?: (err: unknown) => void;
  minDelayMs?: number;
  maxDelayMs?: number;
}): ShopFollower {
  const { shop, minDelayMs = 500, maxDelayMs = 15_000 } = options;
  const controller = new AbortController();
  let chain: Promise<void> = Promise.resolve();

  // Events are handled one at a time, in seq order, and never twice.
  const process = (event: ShopEvent) => {
    chain = chain.then(async () => {
      if (event.seq <= options.cursor()) return;
      try {
        await options.handle(event);
      } catch (err) {
        options.onError?.(err);
      }
    });
    return chain;
  };

  const connectOnce = async () => {
    let buffering = true;
    const buffered: ShopEvent[] = [];
    let markOpen: () => void = () => {};
    const open = new Promise<void>((resolve) => (markOpen = resolve));
    const streaming = shop.stream((event) => (buffering ? buffered.push(event) : void process(event)), markOpen, controller.signal);
    // The stream is opened before catching up, so nothing published in between is lost.
    await Promise.race([open, streaming]);
    await options.onOpen?.();
    for (const event of await shop.events(options.cursor())) void process(event);
    buffering = false;
    for (const event of buffered) void process(event);
    await chain;
    options.setConnected(true);
    await streaming;
  };

  const loop = async () => {
    let delay = minDelayMs;
    while (!controller.signal.aborted) {
      const started = Date.now();
      try {
        await connectOnce();
      } catch (err) {
        if (controller.signal.aborted) break;
        options.onError?.(err);
      }
      options.setConnected(false);
      if (controller.signal.aborted) break;
      delay = Date.now() - started > maxDelayMs ? minDelayMs : Math.min(delay * 2, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay).unref());
    }
  };

  return {
    start: () => void loop(),
    stop: () => controller.abort(),
    exclusive: <T>(fn: () => Promise<T>) => {
      const result = chain.then(fn);
      chain = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}

// ── Ingesting shop events ──

export async function handleShopEvent(h: Healer, event: ShopEvent, resetLocal: () => Promise<void>): Promise<void> {
  const { store } = h;
  switch (event.type) {
    case 'trace.started':
      h.runningTraces.add(event.traceId);
      h.emit({ type: 'stage', stage: 'run', state: 'started', label: `Customer ${event.customerId}` });
      h.scheduleOverview();
      break;
    case 'trace.completed': {
      const { trace } = event;
      h.runningTraces.delete(trace.id);
      h.emit({ type: 'stage', stage: 'run', state: 'finished', label: `Customer ${trace.customerId}` });
      if (store.hasTrace(trace.id)) break;
      store.saveTrace(trace);
      h.recordTraceCost(trace.runs);
      h.activity('run', trace.error ? `A conversation failed to run: ${trace.error}` : `${trace.envBefore.customers.find((c) => c.id === trace.customerId)?.name ?? trace.customerId} (${trace.source}) wrote: "${trace.input.slice(0, 80)}"`, {
        kind: 'trace',
        id: trace.id,
        label: trace.input.slice(0, 60),
      });
      h.changed('trace');
      void runLoop(h, trace.id);
      break;
    }
    case 'feedback': {
      store.setRating(event.traceId, event.rating);
      h.changed('trace');
      if (event.rating === 'down' && store.hasTrace(event.traceId)) {
        h.activity('judge', 'A customer rated a reply thumbs down; judging it again', { kind: 'trace', id: event.traceId, label: event.traceId });
        void runLoop(h, event.traceId);
      }
      break;
    }
    case 'reset':
      await resetLocal();
      break;
    case 'deployment':
      break;
  }
  store.setCursor(event.seq);
}
