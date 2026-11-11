import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Environment,
  factoryVersion,
  seedSnapshot,
  type AgentVersion,
  type Customer,
  type EnvSnapshot,
  type LlmClient,
  type ShopEvent,
  type Trace,
  type TraceSource,
} from '@healer/agent';
import { createHealerApp } from './app.ts';
import type { ShopClient } from './shopLink.ts';

// Test doubles: an in-memory shop speaking the ShopClient contract, and helpers for crafted traces.

type NewEvent = ShopEvent extends infer E ? (E extends ShopEvent ? Omit<E, 'seq' | 'at'> : never) : never;

export class FakeShop implements ShopClient {
  log: ShopEvent[] = [];
  deployed: AgentVersion = factoryVersion();
  deployments: AgentVersion[] = [];
  resets = 0;
  private seq = 0;
  private listeners = new Set<(event: ShopEvent) => void>();

  publish(event: NewEvent): ShopEvent {
    const stored = { ...event, seq: ++this.seq, at: new Date().toISOString() } as ShopEvent;
    this.log.push(stored);
    for (const fn of this.listeners) fn(stored);
    return stored;
  }

  async customers(): Promise<Customer[]> {
    return seedSnapshot().customers;
  }

  async deployment(): Promise<AgentVersion> {
    return structuredClone(this.deployed);
  }

  async deploy(version: AgentVersion): Promise<void> {
    this.deployed = structuredClone(version);
    this.deployments.push(this.deployed);
    this.publish({ type: 'deployment', versionId: version.id });
  }

  async events(after: number): Promise<ShopEvent[]> {
    return this.log.filter((e) => e.seq > after);
  }

  // Chats are recorded and answered by `reply`; no agent runs and no events are published.
  chats: { customerId: string; threadId: string; message: string; source: TraceSource | undefined }[] = [];
  reply: (message: string, turn: number) => string = () => 'Done.';
  env = async (): Promise<EnvSnapshot> => seedSnapshot();

  async chat(input: { customerId: string; threadId?: string; message: string; source?: TraceSource }) {
    const threadId = input.threadId ?? `th_${crypto.randomUUID()}`;
    const turn = this.chats.filter((c) => c.threadId === threadId).length;
    this.chats.push({ customerId: input.customerId, threadId, message: input.message, source: input.source });
    return { threadId, traceId: `tr_${crypto.randomUUID()}`, reply: this.reply(input.message, turn) };
  }

  async reset(): Promise<void> {
    this.resets++;
    this.log = [];
    this.deployed = factoryVersion();
    this.publish({ type: 'reset' });
  }

  stream(onEvent: (event: ShopEvent) => void, opened: () => void, signal: AbortSignal): Promise<void> {
    this.listeners.add(onEvent);
    opened();
    return new Promise((resolve) =>
      signal.addEventListener('abort', () => {
        this.listeners.delete(onEvent);
        resolve();
      }),
    );
  }
}

export function makeTrace(customerId: string, act: (env: Environment) => void, overrides: Partial<Trace> = {}): Trace {
  const env = new Environment(seedSnapshot());
  const envBefore = env.snapshot();
  act(env);
  return {
    id: `tr_${crypto.randomUUID()}`,
    threadId: `th_${crypto.randomUUID()}`,
    customerId,
    versionId: 0,
    source: 'shop',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    history: [],
    input: 'Hello',
    output: 'Done.',
    tierUsed: 'haiku',
    routerDecision: null,
    runs: [],
    toolCalls: [],
    envBefore,
    envAfter: env.snapshot(),
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ...overrides,
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function setupHealer(llm: LlmClient | null, shop = new FakeShop()) {
  const dir = mkdtempSync(join(tmpdir(), 'healer-test-'));
  const healer = createHealerApp({ dbPath: join(dir, 'healer.db'), getLlm: () => llm, shop, reconnectMinMs: 10 });
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await healer.app.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { ...healer, shop, call, dir };
}
