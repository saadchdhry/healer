import { DatabaseSync } from 'node:sqlite';
import type { AgentVersion, ChatTurn, EnvSnapshot, Rating, ShopEvent, Trace, TraceSource } from '@healer/agent';

export type StoredTurn = ChatTurn & { traceId: string | null; at: string };

export interface StoredThread {
  id: string;
  customerId: string;
  source: TraceSource;
  turns: StoredTurn[];
}

// Distributive, so each event variant keeps its own fields once seq and at are removed.
export type NewShopEvent = ShopEvent extends infer E ? (E extends ShopEvent ? Omit<E, 'seq' | 'at'> : never) : never;

// JSON documents in SQLite: one key-value table for singletons, one table per collection.
export class ShopStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ratings (trace_id TEXT PRIMARY KEY, rating TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  private getKv<T>(key: string): T | null {
    const row = this.db.prepare('SELECT doc FROM kv WHERE key = ?').get(key) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as T) : null;
  }

  private setKv(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, doc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET doc = excluded.doc').run(key, JSON.stringify(value));
  }

  env(): EnvSnapshot | null {
    return this.getKv<EnvSnapshot>('env');
  }

  setEnv(env: EnvSnapshot): void {
    this.setKv('env', env);
  }

  deployment(): AgentVersion | null {
    return this.getKv<AgentVersion>('deployment');
  }

  setDeployment(version: AgentVersion): void {
    this.setKv('deployment', version);
  }

  thread(id: string): StoredThread | null {
    const row = this.db.prepare('SELECT doc FROM threads WHERE id = ?').get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as StoredThread) : null;
  }

  threadsFor(customerId: string): StoredThread[] {
    const rows = this.db.prepare('SELECT doc FROM threads WHERE customer_id = ? ORDER BY rowid').all(customerId) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as StoredThread);
  }

  saveThread(thread: StoredThread): void {
    this.db
      .prepare('INSERT INTO threads (id, customer_id, doc) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc')
      .run(thread.id, thread.customerId, JSON.stringify(thread));
  }

  trace(id: string): Trace | null {
    const row = this.db.prepare('SELECT doc FROM traces WHERE id = ?').get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Trace) : null;
  }

  tracesForThread(threadId: string): Trace[] {
    const rows = this.db.prepare('SELECT doc FROM traces WHERE thread_id = ? ORDER BY rowid').all(threadId) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Trace);
  }

  saveTrace(trace: Trace): void {
    this.db.prepare('INSERT INTO traces (id, thread_id, doc) VALUES (?, ?, ?)').run(trace.id, trace.threadId, JSON.stringify(trace));
  }

  rating(traceId: string): Rating | null {
    const row = this.db.prepare('SELECT rating FROM ratings WHERE trace_id = ?').get(traceId) as { rating: Rating } | undefined;
    return row?.rating ?? null;
  }

  setRating(traceId: string, rating: Rating): void {
    this.db
      .prepare('INSERT INTO ratings (trace_id, rating) VALUES (?, ?) ON CONFLICT(trace_id) DO UPDATE SET rating = excluded.rating')
      .run(traceId, rating);
  }

  // AUTOINCREMENT never reuses a seq, even after a reset clears the table, so client cursors stay valid.
  appendEvent(event: NewShopEvent): ShopEvent {
    const at = new Date().toISOString();
    const { lastInsertRowid } = this.db.prepare('INSERT INTO events (doc) VALUES (?)').run(JSON.stringify({ ...event, at }));
    return { ...event, seq: Number(lastInsertRowid), at } as ShopEvent;
  }

  eventsAfter(after: number): ShopEvent[] {
    const rows = this.db.prepare('SELECT seq, doc FROM events WHERE seq > ? ORDER BY seq').all(after) as { seq: number; doc: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.doc), seq: r.seq }) as ShopEvent);
  }

  clearHistory(): void {
    this.db.exec('DELETE FROM threads; DELETE FROM traces; DELETE FROM ratings; DELETE FROM events;');
  }

  transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
