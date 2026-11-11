// Stand-in for the shop and healer services while they do not exist. Only loaded when VITE_MOCK=1.
import type { AgentVersion, HealerEvent, Job, LoopStage, Overview, Proposal, RefKind, Settings, Tier } from '@healer/agent';
import type { Api, RouteKey } from '../lib/api.ts';
import * as fx from './fixtures.ts';

type Ctx<K extends RouteKey> = { params: Record<string, string>; body: Api[K]['body']; query: Record<string, string> };
type Handler<K extends RouteKey> = (ctx: Ctx<K>) => Api[K]['res'] | Response | Promise<Api[K]['res'] | Response>;
type Handlers = { [K in RouteKey]?: Handler<K> };

const noKey = import.meta.env.VITE_MOCK_NO_KEY === '1';
const settings: Settings = { autonomy: 'approve', trialsPerCase: 3 };
let liveVersionId = 3;
const activeStages = new Set<LoopStage>(['gate', 'run']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const notFound = () => new Response(JSON.stringify({ error: 'not_found', message: 'No such record.' }), { status: 404 });

function overview(): Overview {
  const v = fx.versions.find((x) => x.id === liveVersionId)!;
  return {
    shopConnected: true,
    apiKeyPresent: !noKey,
    liveVersionId,
    liveModel: v.model,
    settings,
    activeStages: [...activeStages],
    counts: {
      traces: fx.traces.length,
      verdictsPassed: fx.verdicts.filter((x) => x.passed).length,
      verdictsFailed: fx.verdicts.filter((x) => !x.passed).length,
      issuesOpen: fx.issues.filter((i) => i.status === 'open').length,
      issuesTotal: fx.issues.length,
      proposalsAwaitingApproval: fx.proposals.filter((p) => p.status === 'awaiting_approval').length,
      proposalsTotal: fx.proposals.length,
      gateRunsAccepted: fx.gateRuns.filter((g) => g.decision === 'accept').length,
      gateRunsRejected: fx.gateRuns.filter((g) => g.decision === 'reject').length,
      versions: fx.versions.length,
      contextNotes: v.context.length,
      evalCases: fx.evalCases.length,
      routerExamples: fx.routerDataset.length,
    },
    latestPassRate: fx.evalRuns.filter((r) => r.versionId === liveVersionId && r.status === 'done').at(-1)?.passRate ?? null,
    cost: { totalUsd: fx.costByRole.reduce((s, r) => s + r.costUsd, 0), byRole: fx.costByRole },
  };
}

// ── Fake event streams ────────────────────────────────────────────────────

const sources = new Set<MockEventSource>();

class MockEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  withCredentials = false;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(readonly url: string) {
    super();
    sources.add(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 50);
  }
  deliver(data: unknown) {
    if (this.readyState !== 1) return;
    const e = new MessageEvent('message', { data: JSON.stringify(data) });
    this.onmessage?.(e);
    this.dispatchEvent(e);
  }
  close() {
    this.readyState = 2;
    sources.delete(this);
  }
}

function emit(ev: HealerEvent) {
  for (const s of sources) if (s.url.startsWith('/api/healer/stream')) s.deliver(ev);
}
const changed = (...kinds: RefKind[]) => emit({ type: 'changed', kinds });
const pushOverview = () => emit({ type: 'overview', overview: overview() });
let actSeq = 100;
function activity(stage: LoopStage, text: string, ref: { kind: RefKind; id: string; label: string } | null = null) {
  const entry = { id: `act_${++actSeq}`, at: now(), stage, text, ref };
  fx.activity.unshift(entry);
  emit({ type: 'activity', entry });
}

let jobSeq = 100;
function startJob(kind: Job['kind'], label: string, total: number, stage: LoopStage, kinds: RefKind[], onDone?: () => void): Job {
  const job: Job = { id: `job_${++jobSeq}`, kind, label, status: 'running', progress: { done: 0, total }, startedAt: now(), endedAt: null, refId: null };
  fx.jobs.unshift(job);
  activeStages.add(stage);
  emit({ type: 'stage', stage, state: 'started', label });
  pushOverview();
  const timer = setInterval(() => {
    job.progress.done += 1;
    if (job.progress.done >= total) {
      clearInterval(timer);
      job.status = 'done';
      job.endedAt = now();
      onDone?.();
      activeStages.delete(stage);
      emit({ type: 'stage', stage, state: 'finished', label });
      activity(stage, `${label}: finished`);
      changed('trace', ...kinds);
      pushOverview();
    }
    emit({ type: 'job', job: { ...job, progress: { ...job.progress } } });
  }, 700);
  return job;
}

// Keeps the two seeded running jobs moving so the console looks alive.
setInterval(() => {
  for (const j of fx.jobs) {
    if (j.status !== 'running' || Number(j.id.slice(4)) > 100) continue;
    j.progress.done = Math.min(j.progress.total - 1, j.progress.done + 1);
    emit({ type: 'job', job: { ...j, progress: { ...j.progress } } });
  }
}, 2500);

// ── Routes ────────────────────────────────────────────────────────────────

function deploy(v: AgentVersion) {
  for (const x of fx.versions) if (x.status === 'live') x.status = 'superseded';
  v.status = 'live';
  liveVersionId = v.id;
  activity('promote', `Version ${v.id} is live in the shop`, { kind: 'version', id: String(v.id), label: `v${v.id}` });
  changed('version', 'proposal');
  pushOverview();
}

function newVersion(parent: AgentVersion, patch: Partial<AgentVersion>): AgentVersion {
  const v: AgentVersion = { ...structuredClone(parent), id: Math.max(...fx.versions.map((x) => x.id)) + 1, parentId: parent.id, createdAt: now(), status: 'candidate', proposalId: null, gated: true, ...patch };
  fx.versions.push(v);
  return v;
}

const handlers: Handlers = {
  'GET /api/shop/customers': () => fx.customers,
  'GET /api/shop/customers/:id/orders': ({ params }) => fx.orders.filter((o) => o.customerId === params.id),
  'GET /api/shop/customers/:id/threads': ({ params }) => fx.threads.filter((t) => t.customerId === params.id),
  'POST /api/shop/chat': async ({ body }) => {
    if (noKey) return new Response(JSON.stringify({ error: 'missing_api_key', message: 'ANTHROPIC_API_KEY is not set.' }), { status: 503 });
    await sleep(2200);
    const traceId = `tr_live_${Date.now()}`;
    activity('run', `A customer wrote: ${body.message.slice(0, 60)}`, { kind: 'trace', id: traceId, label: traceId });
    changed('trace');
    const reply = /refund/i.test(body.message)
      ? 'I can help with that. I have looked up your order. Refunds are possible within 30 days of delivery, so let me check the dates and come back to you with the exact amount.'
      : 'Thanks for getting in touch. I have checked your account and everything looks in order. Is there anything specific about one of your orders I can help with?';
    return { threadId: body.threadId ?? `th_${Date.now()}`, traceId, reply };
  },
  'POST /api/shop/feedback': () => ({ ok: true }),

  'GET /api/healer/overview': () => overview(),
  'GET /api/healer/graphs': () => fx.graphs,
  'GET /api/healer/activity': ({ query }) => fx.activity.slice(0, Number(query.limit ?? 50)),
  'GET /api/healer/lineage': ({ query }) => fx.lineageFor(query.kind as RefKind, query.id!),
  'GET /api/healer/settings': () => settings,
  'PUT /api/healer/settings': ({ body }) => {
    Object.assign(settings, body);
    pushOverview();
    return settings;
  },
  'GET /api/healer/cost': () => ({ totalUsd: fx.costByRole.reduce((s, r) => s + r.costUsd, 0), byRole: fx.costByRole }),
  'GET /api/healer/jobs': () => fx.jobs,
  'POST /api/healer/reset': async () => {
    await sleep(600);
    liveVersionId = 0;
    activity('promote', 'Reset to factory: version 0 is live');
    changed('trace', 'verdict', 'issue', 'proposal', 'gateRun', 'version', 'evalCase', 'evalRun');
    pushOverview();
    return { ok: true };
  },

  'GET /api/healer/customers': () => fx.customers,
  'GET /api/healer/traces': ({ query }) =>
    fx
      .traceSummaries()
      .filter((t) => (!query.source || t.source === query.source) && (!query.verdict || t.verdict === query.verdict) && (!query.versionId || t.versionId === Number(query.versionId)))
      .slice(0, Number(query.limit ?? 200)),
  'GET /api/healer/traces/:id': ({ params }) => {
    const trace = fx.traces.find((t) => t.id === params.id) ?? fx.syntheticTrace(params.id!);
    return { trace, verdict: fx.verdicts.find((v) => v.traceId === trace.id) ?? null, rating: fx.ratings[trace.id] ?? null, lineage: fx.lineageFor('trace', trace.id) };
  },
  'GET /api/healer/threads/:id': ({ params }) => fx.traceSummaries().filter((t) => t.threadId === params.id),

  'GET /api/healer/rules': () => fx.rules,
  'GET /api/healer/verdicts': ({ query }) => fx.verdicts.filter((v) => query.passed === undefined || String(v.passed) === query.passed).slice().reverse(),
  'POST /api/healer/traces/:id/judge': async ({ params }) => {
    await sleep(1500);
    const v = fx.verdicts.find((x) => x.traceId === params.id);
    if (!v) return notFound();
    const again = { ...v, id: `${v.id}_r${Date.now() % 1000}`, createdAt: now() };
    activity('judge', `Re-judged ${params.id}`, { kind: 'verdict', id: again.id, label: again.id });
    changed('verdict');
    return again;
  },

  'GET /api/healer/issues': () => fx.issues,
  'GET /api/healer/issues/:id': ({ params }) => {
    const issue = fx.issues.find((i) => i.id === params.id);
    return issue ? { issue, lineage: fx.lineageFor('issue', issue.id) } : notFound();
  },
  'POST /api/healer/diagnose': () => startJob('diagnose', 'Diagnose failed verdicts', 4, 'diagnose', ['issue']),
  'POST /api/healer/issues/:id/dismiss': ({ params }) => {
    const issue = fx.issues.find((i) => i.id === params.id)!;
    issue.status = 'dismissed';
    changed('issue');
    return issue;
  },

  'GET /api/healer/proposals': () => fx.proposals.slice().reverse(),
  'GET /api/healer/proposals/:id': ({ params }) => {
    const proposal = fx.proposals.find((p) => p.id === params.id);
    if (!proposal) return notFound();
    return {
      proposal,
      base: fx.versions.find((v) => v.id === proposal.baseVersionId)!,
      candidate: fx.versions.find((v) => v.id === proposal.candidateVersionId)!,
      gateRun: fx.gateRuns.find((g) => g.id === proposal.gateRunId) ?? null,
      lineage: fx.lineageFor('proposal', proposal.id),
    };
  },
  'POST /api/healer/issues/:id/propose': () => startJob('propose', 'Propose a fix', 3, 'propose', ['proposal']),
  'POST /api/healer/proposals': ({ body }) => {
    const base = fx.versions.find((v) => v.id === liveVersionId)!;
    const cand = newVersion(base, { author: 'human', summary: body.title });
    const p: Proposal = { id: `prop_${Date.now() % 100000}`, createdAt: now(), author: 'human', issueId: null, title: body.title, rationale: body.rationale, baseVersionId: base.id, candidateVersionId: cand.id, changes: body.changes, status: 'draft', gateRunId: null, proposeRun: null };
    cand.proposalId = p.id;
    fx.proposals.push(p);
    activity('propose', `Hand-written proposal: ${p.title}`, { kind: 'proposal', id: p.id, label: p.id });
    changed('proposal');
    return p;
  },
  'POST /api/healer/proposals/:id/gate': ({ params }) => {
    const p = fx.proposals.find((x) => x.id === params.id)!;
    p.status = 'gating';
    changed('proposal');
    return startJob('gate', `Gate ${p.id}`, 6, 'gate', ['gateRun', 'proposal'], () => {
      p.status = 'awaiting_approval';
    });
  },
  'POST /api/healer/proposals/:id/approve': ({ params }) => {
    const p = fx.proposals.find((x) => x.id === params.id)!;
    p.status = 'promoted';
    const v = fx.versions.find((x) => x.id === p.candidateVersionId)!;
    deploy(v);
    return v;
  },
  'POST /api/healer/proposals/:id/discard': ({ params }) => {
    const p = fx.proposals.find((x) => x.id === params.id)!;
    p.status = 'discarded';
    changed('proposal');
    return p;
  },

  'GET /api/healer/gate-runs': () => fx.gateRuns.slice().reverse(),
  'GET /api/healer/gate-runs/:id': ({ params }) => {
    const gateRun = fx.gateRuns.find((g) => g.id === params.id);
    if (!gateRun) return notFound();
    return { gateRun, baseRun: fx.evalRuns.find((r) => r.id === gateRun.baseRunId) ?? null, candidateRun: fx.evalRuns.find((r) => r.id === gateRun.candidateRunId) ?? null, lineage: fx.lineageFor('gateRun', gateRun.id) };
  },

  'GET /api/healer/versions': () => fx.versions,
  'GET /api/healer/versions/:id': ({ params }) => {
    const version = fx.versions.find((v) => String(v.id) === params.id);
    if (!version) return notFound();
    return { version, parent: fx.versions.find((v) => v.id === version.parentId) ?? null, latestRun: fx.evalRuns.filter((r) => r.versionId === version.id).at(-1) ?? null, lineage: fx.lineageFor('version', String(version.id)) };
  },
  'POST /api/healer/versions/:id/rollback': ({ params }) => {
    const old = fx.versions.find((v) => String(v.id) === params.id)!;
    const v = newVersion(old, { author: 'human', summary: `Rollback to version ${old.id}`, gated: false });
    deploy(v);
    return v;
  },
  'GET /api/healer/model': () => ({
    live: fx.versions.find((v) => v.id === liveVersionId)!.model,
    pricing: {
      haiku: { modelId: 'claude-haiku-5-5', inputPerMTok: 1, outputPerMTok: 5 },
      sonnet: { modelId: 'claude-sonnet-5-5', inputPerMTok: 3, outputPerMTok: 15 },
      opus: { modelId: 'claude-opus-5-5', inputPerMTok: 5, outputPerMTok: 25 },
    },
    routers: fx.routerModels,
    dataset: fx.routerDataset,
  }),
  'POST /api/healer/model/tier': ({ body }) => {
    const live = fx.versions.find((v) => v.id === liveVersionId)!;
    const v = newVersion(live, { author: 'human', summary: `Manual switch to ${body.tier}`, gated: false, model: { mode: 'fixed', tier: body.tier as Tier, effort: 'low' } });
    deploy(v);
    return v;
  },
  'POST /api/healer/model/router/dataset': ({ body }) => startJob('router_dataset', `Build router dataset, up to ${body.maxExamples} examples`, 5, 'gate', ['evalRun']),
  'POST /api/healer/model/router/train': async () => {
    await sleep(800);
    const r = { ...fx.routerModels.at(-1)!, id: `rtr_0${fx.routerModels.length + 1}`, createdAt: now() };
    fx.routerModels.push(r);
    activity('propose', `Trained router ${r.id}`);
    changed('version');
    return r;
  },
  'POST /api/healer/model/router/:id/propose': ({ params }) => {
    const base = fx.versions.find((v) => v.id === liveVersionId)!;
    const router = fx.routerModels.find((r) => r.id === params.id)!;
    const model = { mode: 'routed' as const, easyTier: 'haiku' as const, hardTier: 'sonnet' as const, effort: 'low' as const, router };
    const cand = newVersion(base, { author: 'human', summary: `Route with ${router.id}`, model });
    const p: Proposal = { id: `prop_${Date.now() % 100000}`, createdAt: now(), author: 'human', issueId: null, title: `Route with ${router.id}`, rationale: 'Send easy requests to the small model.', baseVersionId: base.id, candidateVersionId: cand.id, changes: [{ surface: 'model', op: 'set_model', model }], status: 'draft', gateRunId: null, proposeRun: null };
    cand.proposalId = p.id;
    fx.proposals.push(p);
    changed('proposal');
    return p;
  },

  'GET /api/healer/evals': () =>
    fx.evalCases.map((c) => ({
      case: c,
      history: fx.versions
        .map((v) => {
          const r = fx.evalRuns.filter((x) => x.versionId === v.id && x.status === 'done').at(-1)?.results.find((x) => x.caseId === c.id);
          return r ? { versionId: v.id, passRate: r.passRate, passed: r.passed } : null;
        })
        .filter((x) => x !== null),
    })),
  'GET /api/healer/evals/:id': ({ params }) => {
    const c = fx.evalCases.find((x) => x.id === params.id);
    if (!c) return notFound();
    const history = fx.versions
      .map((v) => {
        const r = fx.evalRuns.filter((x) => x.versionId === v.id && x.status === 'done').at(-1)?.results.find((x) => x.caseId === c.id);
        return r ? { versionId: v.id, passRate: r.passRate, passed: r.passed } : null;
      })
      .filter((x) => x !== null);
    return { case: c, history, lineage: fx.lineageFor('evalCase', c.id) };
  },
  'POST /api/healer/evals': ({ body }) => {
    const c = { id: `ev_${Date.now() % 100000}`, createdAt: now(), origin: 'human' as const, sourceTraceId: null, issueId: null, history: [], env: fx.env, enabled: true, ...body };
    fx.evalCases.push(c);
    changed('evalCase');
    return c;
  },
  'PATCH /api/healer/evals/:id': ({ params, body }) => {
    const c = fx.evalCases.find((x) => x.id === params.id)!;
    Object.assign(c, body);
    changed('evalCase');
    return c;
  },
  'POST /api/healer/evals/run': ({ body }) => startJob('eval', `Run the eval suite on version ${body.versionId}`, 9, 'gate', ['evalRun']),
  'GET /api/healer/eval-runs': () => fx.evalRuns,
  'GET /api/healer/eval-runs/:id': ({ params }) => fx.evalRuns.find((r) => r.id === params.id) ?? notFound(),

  'GET /api/healer/seeds': () => fx.seeds,
  'POST /api/healer/seeds/:id/fire': ({ params }) => startJob('simulate', `Fire seeded case ${params.id}`, 2, 'run', ['trace']),
  'POST /api/healer/simulate': ({ body }) => startJob('simulate', `Send ${body.count} simulated customers`, body.count, 'run', ['trace']),
  'POST /api/healer/redteam': ({ body }) => startJob('redteam', `Red team probe, ${body.count} pairs`, body.count * 2, 'judge', ['trace']),
  'GET /api/healer/findings': () => fx.findings,
};

const table = Object.entries(handlers).map(([key, fn]) => {
  const [method, path] = key.split(' ') as [string, string];
  const names: string[] = [];
  const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, n: string) => (names.push(n), '([^/]+)'))}$`);
  return { method, re, names, fn: fn as (ctx: Ctx<RouteKey>) => unknown };
});

const realFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  await sleep(120 + Math.random() * 180);
  for (const r of table) {
    const m = r.method === method ? url.pathname.match(r.re) : null;
    if (!m) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const out = await r.fn({ params, body, query: Object.fromEntries(url.searchParams) } as Ctx<RouteKey>);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'not_found', message: `Mock has no route for ${method} ${url.pathname}` }), { status: 404 });
};

window.EventSource = MockEventSource as unknown as typeof EventSource;

console.info('[healer] mock services active (VITE_MOCK=1)');
