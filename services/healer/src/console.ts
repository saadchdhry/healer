import {
  factoryVersion,
  type HealerEvent,
  type Job,
  type LlmClient,
  type LlmRole,
  type LoopStage,
  type Overview,
  type Ref,
  type RefKind,
  type Run,
  type Usage,
} from '@healer/agent';
import type { ShopClient } from './shopLink.ts';
import type { HealerStore } from './store.ts';

export class MissingKeyError extends Error {
  constructor() {
    super('No ANTHROPIC_API_KEY is set, so no model can be called.');
  }
}

// Thrown into work that was queued or running when the healer was reset.
export class StaleWorkError extends Error {
  constructor() {
    super('Abandoned because the healer was reset.');
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export const now = () => new Date().toISOString();

export interface JobHandle {
  job: Job;
  progress(done: number, total?: number): void;
  setRef(refId: string): void;
}

// The shared context every stage works through: the store, the shop, the model, and the console's event plumbing.
export class Healer {
  shopConnected = false;
  shopToday: string | null = null;
  // Bumped by reset; work started under an older epoch stops at its next check.
  epoch = 0;
  private listeners = new Set<(event: HealerEvent) => void>();
  private stages = new Map<LoopStage, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private overviewTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly store: HealerStore,
    readonly shop: ShopClient,
    private getLlm: () => LlmClient | null,
  ) {}

  llm(): LlmClient {
    const llm = this.getLlm();
    if (!llm) throw new MissingKeyError();
    return llm;
  }

  hasLlm(): boolean {
    return this.getLlm() !== null;
  }

  // ── Events ──

  subscribe(fn: (event: HealerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  emit(event: HealerEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  changed(...kinds: RefKind[]): void {
    this.emit({ type: 'changed', kinds });
    this.scheduleOverview();
  }

  private closed = false;

  close(): void {
    this.closed = true;
    if (this.overviewTimer) clearTimeout(this.overviewTimer);
  }

  scheduleOverview(): void {
    if (this.overviewTimer || this.closed) return;
    this.overviewTimer = setTimeout(() => {
      this.overviewTimer = null;
      this.emit({ type: 'overview', overview: this.overview() });
    }, 150);
    this.overviewTimer.unref();
  }

  activity(stage: LoopStage | null, text: string, ref: Ref | null = null): void {
    const entry = this.store.activity.put({ id: newId('act'), at: now(), stage, text, ref });
    this.emit({ type: 'activity', entry });
  }

  async stage<T>(stage: LoopStage, label: string, fn: () => Promise<T>): Promise<T> {
    this.stages.set(stage, (this.stages.get(stage) ?? 0) + 1);
    this.emit({ type: 'stage', stage, state: 'started', label });
    try {
      return await fn();
    } finally {
      const left = this.stages.get(stage)! - 1;
      if (left) this.stages.set(stage, left);
      else this.stages.delete(stage);
      this.emit({ type: 'stage', stage, state: 'finished', label });
      this.scheduleOverview();
    }
  }

  // Shop traces started but not yet completed: while any are running, the "run" stage is active.
  readonly runningTraces = new Set<string>();

  activeStages(): LoopStage[] {
    const stages = [...this.stages.keys()];
    return this.runningTraces.size ? ['run', ...stages] : stages;
  }

  // ── Cost ledger ──

  recordRun(run: Run): void {
    if (run.usage && run.role) this.recordUsage(run.role, run.model ?? 'unknown', run.usage);
  }

  recordUsage(role: LlmRole, model: string, usage: Usage): void {
    this.store.addCost({ role, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
  }

  // Agent model calls inside a trace, each priced by the model that answered.
  recordTraceCost(runs: Run[]): void {
    for (const run of runs) if (run.kind === 'model') this.recordRun(run);
  }

  // ── Work queue and jobs ──

  // Every piece of loop work runs here, one at a time, so a burst of traffic cannot start parallel gates.
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const run = () => {
      if (epoch !== this.epoch) throw new StaleWorkError();
      return fn();
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  checkEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new StaleWorkError();
  }

  // Registers a job and runs `work` straight away, for work already running inside the queue.
  async trackJob<T>(kind: Job['kind'], label: string, refId: string | null, work: (handle: JobHandle) => Promise<T>, job = this.newJob(kind, label, refId)): Promise<T> {
    const save = () => {
      this.store.jobs.put(job);
      this.emit({ type: 'job', job: structuredClone(job) });
    };
    save();
    const handle: JobHandle = {
      job,
      progress: (done, total) => {
        job.progress = { done, total: total ?? job.progress.total };
        save();
      },
      setRef: (id) => {
        job.refId = id;
        save();
      },
    };
    try {
      const result = await work(handle);
      job.status = 'done';
      return result;
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      job.endedAt = now();
      if (this.store.jobs.get(job.id)) save();
    }
  }

  // Registers a job, returns it at once, and runs `work` through the queue. Traffic is not loop work, so it
  // runs beside the queue (`queued` false): customers keep arriving while the loop is busy, as they would in a real shop.
  startJob(kind: Job['kind'], label: string, refId: string | null, work: (handle: JobHandle) => Promise<void>, queued = true): Job {
    const job = this.newJob(kind, label, refId);
    this.store.jobs.put(job);
    this.emit({ type: 'job', job: structuredClone(job) });
    const run = () => this.trackJob(kind, label, refId, work, job);
    (queued ? this.enqueue(run) : run()).catch((err: unknown) => {
      if (!(err instanceof StaleWorkError)) this.activity('run', `Job "${label}" failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return structuredClone(job);
  }

  private newJob(kind: Job['kind'], label: string, refId: string | null): Job {
    return { id: newId('job'), kind, label, status: 'running', progress: { done: 0, total: 0 }, startedAt: now(), endedAt: null, refId };
  }

  // ── Overview ──

  overview(): Overview {
    const { store } = this;
    const live = store.liveVersion() ?? factoryVersion();
    const issues = store.issues.list();
    const proposals = store.proposals.list();
    const gateRuns = store.gateRuns.list();
    const verdicts = store.verdictCounts();
    const latestRun = store.evalRuns.list().filter((r) => r.status === 'done' && r.versionId === live.id).at(-1);
    return {
      shopConnected: this.shopConnected,
      shopToday: this.shopToday,
      apiKeyPresent: this.hasLlm(),
      liveVersionId: live.id,
      liveModel: live.model,
      settings: store.settings(),
      activeStages: this.activeStages(),
      counts: {
        traces: store.traceCount(),
        sandboxTraces: store.sandboxTraceCount(),
        verdictsPassed: verdicts.passed,
        verdictsFailed: verdicts.failed,
        issuesOpen: issues.filter((i) => i.status === 'open' || i.status === 'proposed').length,
        issuesTotal: issues.length,
        proposalsAwaitingApproval: proposals.filter((p) => p.status === 'awaiting_approval').length,
        proposalsTotal: proposals.length,
        gateRunsAccepted: gateRuns.filter((g) => g.decision === 'accept').length,
        gateRunsRejected: gateRuns.filter((g) => g.decision === 'reject').length,
        versions: store.versions.count(),
        contextNotes: live.context.length,
        evalCases: store.evalCases.list().filter((c) => c.enabled).length,
        routerExamples: store.routerDataset().length,
      },
      latestPassRate: latestRun?.passRate ?? null,
      cost: store.costByRole(),
    };
  }
}
