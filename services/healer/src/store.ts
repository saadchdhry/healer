import { DatabaseSync } from 'node:sqlite';
import type {
  ActivityEntry,
  AgentVersion,
  CostByRole,
  EvalCase,
  EvalRun,
  GateRun,
  Issue,
  Job,
  LlmRole,
  Proposal,
  Rating,
  RedTeamFinding,
  RouterExample,
  RouterModel,
  Settings,
  Trace,
  TraceSource,
  TraceSummary,
  Verdict,
} from '@healer/agent';

export const DEFAULT_SETTINGS: Settings = { autonomy: 'approve', trialsPerCase: 3 };

// Traces the healer ran itself, in a sandbox, rather than conversations that reached the shop.
export const SANDBOX_SOURCES: TraceSource[] = ['eval', 'replay', 'redteam'];
const SANDBOX_SQL = SANDBOX_SOURCES.map((s) => `'${s}'`).join(', ');

// A JSON document collection kept in insertion order. Ids are strings; versions use their number as text.
export class Collection<T> {
  constructor(
    private db: DatabaseSync,
    private name: string,
    private key: (doc: T) => string,
  ) {}

  get(id: string | number): T | null {
    const row = this.db.prepare('SELECT doc FROM docs WHERE collection = ? AND id = ?').get(this.name, String(id)) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as T) : null;
  }

  put(doc: T): T {
    this.db
      .prepare('INSERT INTO docs (collection, id, doc) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET doc = excluded.doc')
      .run(this.name, this.key(doc), JSON.stringify(doc));
    return doc;
  }

  // Oldest first.
  list(): T[] {
    const rows = this.db.prepare('SELECT doc FROM docs WHERE collection = ? ORDER BY seq').all(this.name) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as T);
  }

  latest(limit: number): T[] {
    const rows = this.db.prepare('SELECT doc FROM docs WHERE collection = ? ORDER BY seq DESC LIMIT ?').all(this.name, limit) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as T);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM docs WHERE collection = ?').get(this.name) as { n: number }).n;
  }
}

export interface CostEntry {
  role: LlmRole;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TraceFilter {
  source?: TraceSource;
  versionId?: number;
  threadId?: string;
  customerId?: string;
}

export class HealerStore {
  private db: DatabaseSync;
  readonly issues: Collection<Issue>;
  readonly proposals: Collection<Proposal>;
  readonly gateRuns: Collection<GateRun>;
  readonly versions: Collection<AgentVersion>;
  readonly evalCases: Collection<EvalCase>;
  readonly evalRuns: Collection<EvalRun>;
  readonly jobs: Collection<Job>;
  readonly activity: Collection<ActivityEntry>;
  readonly findings: Collection<RedTeamFinding>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS docs (seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, id TEXT NOT NULL, doc TEXT NOT NULL, UNIQUE (collection, id));
      CREATE TABLE IF NOT EXISTS traces (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, customer_id TEXT NOT NULL,
        version_id INTEGER NOT NULL, source TEXT NOT NULL, started_at TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL,
        tier TEXT NOT NULL, cost REAL NOT NULL, doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS traces_thread ON traces (thread_id);
      CREATE TABLE IF NOT EXISTS verdicts (seq INTEGER PRIMARY KEY AUTOINCREMENT, trace_id TEXT NOT NULL UNIQUE, passed INTEGER NOT NULL, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ratings (trace_id TEXT PRIMARY KEY, rating TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cost (seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL NOT NULL);
    `);
    const docs = <T>(name: string, key: (doc: T) => string) => new Collection<T>(this.db, name, key);
    this.issues = docs('issues', (d) => d.id);
    this.proposals = docs('proposals', (d) => d.id);
    this.gateRuns = docs('gateRuns', (d) => d.id);
    this.versions = docs('versions', (d) => String(d.id));
    this.evalCases = docs('evalCases', (d) => d.id);
    this.evalRuns = docs('evalRuns', (d) => d.id);
    this.jobs = docs('jobs', (d) => d.id);
    this.activity = docs('activity', (d) => d.id);
    this.findings = docs('findings', (d) => d.id);
  }

  close(): void {
    this.db.close();
  }

  wipe(): void {
    this.db.exec('DELETE FROM kv; DELETE FROM docs; DELETE FROM traces; DELETE FROM verdicts; DELETE FROM ratings; DELETE FROM cost;');
  }

  private getKv<T>(key: string): T | null {
    const row = this.db.prepare('SELECT doc FROM kv WHERE key = ?').get(key) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as T) : null;
  }

  private setKv(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, doc) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET doc = excluded.doc').run(key, JSON.stringify(value));
  }

  settings(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.getKv<Settings>('settings') };
  }

  setSettings(settings: Settings): void {
    this.setKv('settings', settings);
  }

  // The seq of the last shop event ingested.
  cursor(): number {
    return this.getKv<number>('cursor') ?? 0;
  }

  setCursor(seq: number): void {
    this.setKv('cursor', seq);
  }

  // When each eval case last had its checks edited. Suite results older than this are not reused for that case.
  checksEditedAt(): Record<string, string> {
    return this.getKv<Record<string, string>>('checksEditedAt') ?? {};
  }

  markChecksEdited(caseId: string, at: string): void {
    this.setKv('checksEditedAt', { ...this.checksEditedAt(), [caseId]: at });
  }

  // Router training state: every trained router is kept as a weights version, oldest first.
  routers(): RouterModel[] {
    return this.getKv<RouterModel[]>('routers') ?? [];
  }

  setRouters(routers: RouterModel[]): void {
    this.setKv('routers', routers);
  }

  routerDataset(): RouterExample[] {
    return this.getKv<RouterExample[]>('routerDataset') ?? [];
  }

  setRouterDataset(examples: RouterExample[]): void {
    this.setKv('routerDataset', examples);
  }

  // ── Versions ──

  liveVersion(): AgentVersion | null {
    return this.versions.list().find((v) => v.status === 'live') ?? null;
  }

  nextVersionId(): number {
    return Math.max(-1, ...this.versions.list().map((v) => v.id)) + 1;
  }

  // ── Traces ──

  hasTrace(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM traces WHERE id = ?').get(id));
  }

  saveTrace(trace: Trace): void {
    this.db
      .prepare(
        `INSERT INTO traces (id, thread_id, customer_id, version_id, source, started_at, input, output, tier, cost, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        trace.id,
        trace.threadId,
        trace.customerId,
        trace.versionId,
        trace.source,
        trace.startedAt,
        trace.input,
        trace.output,
        trace.tierUsed,
        trace.usage.costUsd,
        JSON.stringify(trace),
      );
  }

  trace(id: string): Trace | null {
    const row = this.db.prepare('SELECT doc FROM traces WHERE id = ?').get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Trace) : null;
  }

  tracesForThread(threadId: string): Trace[] {
    const rows = this.db.prepare('SELECT doc FROM traces WHERE thread_id = ? ORDER BY seq').all(threadId) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Trace);
  }

  // Newest first.
  traceSummaries(filter: TraceFilter = {}): TraceSummary[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.source) (where.push('t.source = ?'), args.push(filter.source));
    if (filter.versionId !== undefined) (where.push('t.version_id = ?'), args.push(filter.versionId));
    if (filter.threadId) (where.push('t.thread_id = ?'), args.push(filter.threadId));
    if (filter.customerId) (where.push('t.customer_id = ?'), args.push(filter.customerId));
    const rows = this.db
      .prepare(
        `SELECT t.id, t.thread_id, t.customer_id, t.version_id, t.source, t.started_at, t.input, t.output, t.tier, t.cost, v.passed, r.rating
         FROM traces t LEFT JOIN verdicts v ON v.trace_id = t.id LEFT JOIN ratings r ON r.trace_id = t.id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.seq DESC`,
      )
      .all(...args) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      id: r.id as string,
      threadId: r.thread_id as string,
      customerId: r.customer_id as string,
      versionId: r.version_id as number,
      source: r.source as TraceSource,
      startedAt: r.started_at as string,
      input: r.input as string,
      output: r.output as string,
      tierUsed: r.tier as TraceSummary['tierUsed'],
      costUsd: r.cost as number,
      verdict: r.passed === null ? 'pending' : r.passed ? 'pass' : 'fail',
      rating: (r.rating as Rating | null) ?? null,
    }));
  }

  traceCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM traces WHERE source NOT IN (${SANDBOX_SQL})`).get() as { n: number }).n;
  }

  sandboxTraceCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM traces WHERE source IN (${SANDBOX_SQL})`).get() as { n: number }).n;
  }

  traceCountsBySource(): Record<TraceSource, number> {
    const counts: Record<TraceSource, number> = { shop: 0, simulator: 0, seed: 0, eval: 0, redteam: 0, replay: 0 };
    const rows = this.db.prepare('SELECT source, COUNT(*) AS n FROM traces GROUP BY source').all() as { source: TraceSource; n: number }[];
    for (const r of rows) counts[r.source] = r.n;
    return counts;
  }

  // ── Verdicts and ratings ──

  // One verdict per trace: re-judging replaces it.
  saveVerdict(verdict: Verdict): void {
    this.db
      .prepare('INSERT INTO verdicts (trace_id, passed, doc) VALUES (?, ?, ?) ON CONFLICT(trace_id) DO UPDATE SET passed = excluded.passed, doc = excluded.doc')
      .run(verdict.traceId, verdict.passed ? 1 : 0, JSON.stringify(verdict));
  }

  verdict(id: string): Verdict | null {
    const row = this.db.prepare("SELECT doc FROM verdicts WHERE json_extract(doc, '$.id') = ?").get(id) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Verdict) : null;
  }

  verdictForTrace(traceId: string): Verdict | null {
    const row = this.db.prepare('SELECT doc FROM verdicts WHERE trace_id = ?').get(traceId) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as Verdict) : null;
  }

  // Newest first.
  verdicts(filter: { passed?: boolean; limit?: number } = {}): Verdict[] {
    const where = filter.passed === undefined ? '' : `WHERE passed = ${filter.passed ? 1 : 0}`;
    const rows = this.db.prepare(`SELECT doc FROM verdicts ${where} ORDER BY seq DESC LIMIT ?`).all(filter.limit ?? -1) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as Verdict);
  }

  verdictCounts(): { passed: number; failed: number } {
    const row = this.db.prepare('SELECT COALESCE(SUM(passed), 0) AS p, COUNT(*) AS n FROM verdicts').get() as { p: number; n: number };
    return { passed: row.p, failed: row.n - row.p };
  }

  rating(traceId: string): Rating | null {
    const row = this.db.prepare('SELECT rating FROM ratings WHERE trace_id = ?').get(traceId) as { rating: Rating } | undefined;
    return row?.rating ?? null;
  }

  setRating(traceId: string, rating: Rating): void {
    this.db.prepare('INSERT INTO ratings (trace_id, rating) VALUES (?, ?) ON CONFLICT(trace_id) DO UPDATE SET rating = excluded.rating').run(traceId, rating);
  }

  // ── Cost ledger ──

  addCost(entry: CostEntry): void {
    this.db
      .prepare('INSERT INTO cost (role, model, input, output, cost) VALUES (?, ?, ?, ?, ?)')
      .run(entry.role, entry.model, entry.inputTokens, entry.outputTokens, entry.costUsd);
  }

  costByRole(): { totalUsd: number; byRole: CostByRole[] } {
    const rows = this.db
      .prepare('SELECT role, COUNT(*) AS calls, SUM(input) AS i, SUM(output) AS o, SUM(cost) AS c FROM cost GROUP BY role ORDER BY role')
      .all() as { role: LlmRole; calls: number; i: number; o: number; c: number }[];
    const byRole = rows.map((r) => ({ role: r.role, calls: r.calls, inputTokens: r.i, outputTokens: r.o, costUsd: r.c }));
    return { totalUsd: byRole.reduce((n, r) => n + r.costUsd, 0), byRole };
  }
}
