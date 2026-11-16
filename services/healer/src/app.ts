import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  agentGraphShape,
  PRICING,
  seedSnapshot,
  type EvalCase,
  type EvalCaseView,
  type HealerApi,
  type Issue,
  type LlmClient,
  type RefKind,
  type TraceSummary,
} from '@healer/agent';
import { Healer, MissingKeyError, newId, now } from './console.ts';
import { startDiagnoseJob } from './diagnose.ts';
import { caseHistory, startEvalJob } from './evalRunner.ts';
import { caseValidationSchema, checkSpecSchema, isStrictCase } from './evals.ts';
import { startGateJob } from './gate.ts';
import { goldenCases } from './golden.ts';
import { judgeTrace } from './judge.ts';
import { lineage } from './lineage.ts';
import { loopGraphShape, runLoop } from './loop.ts';
import { POLICY_RULES } from './policy.ts';
import { approve, rollback, setTier } from './promote.ts';
import { ChangeError, changeSchema, createProposal, discardProposal, isOpenProposal, proposeAgain, startProposeJob } from './propose.ts';
import { startRedTeamJob } from './redteam.ts';
import { proposeRouter, startDatasetJob, trainAndStore } from './routerTraining.ts';
import { SEEDED_CASES, startFireJob } from './seeds.ts';
import { followShop, handleShopEvent, type ShopClient } from './shopLink.ts';
import { startSimulateJob } from './simulate.ts';
import { HealerStore, SANDBOX_SOURCES } from './store.ts';
import { startValidateJob } from './validate.ts';

type Res<K extends keyof HealerApi> = HealerApi[K]['res'];

export interface HealerOptions {
  dbPath: string;
  // Called per model call, so a key added to the environment later is picked up. Null means no key.
  getLlm: () => LlmClient | null;
  shop: ShopClient;
  keepAliveMs?: number;
  reconnectMinMs?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
const conflict = (message: string) => new HttpError(409, 'conflict', message);

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_input', 'The body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_input', z.prettifyError(parsed.error));
  return parsed.data;
}

function query<T>(c: Context, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new HttpError(400, 'invalid_input', z.prettifyError(parsed.error));
  return parsed.data;
}

const REF_KINDS = ['trace', 'verdict', 'issue', 'proposal', 'gateRun', 'version', 'evalCase', 'evalRun', 'finding'] as const satisfies RefKind[];
const ALL_KINDS: RefKind[] = [...REF_KINDS];
const limitParam = z.coerce.number().int().positive().optional();

export function createHealerApp(options: HealerOptions) {
  const store = new HealerStore(options.dbPath);
  const h = new Healer(store, options.shop, options.getLlm);

  const seed = () => {
    if (!store.evalCases.list().some((c) => c.origin === 'golden')) for (const c of goldenCases()) store.evalCases.put(c);
  };

  // Registers the shop's deployed version as the first version when the registry is empty.
  const registerShopVersion = async () => {
    if (store.versions.count()) return;
    const deployed = await options.shop.deployment();
    store.versions.put({ ...deployed, status: 'live' });
    h.activity('promote', `Registered the shop's deployed version ${deployed.id} as the starting version`, { kind: 'version', id: String(deployed.id), label: `v${deployed.id}` });
    h.changed('version');
  };

  const resetLocal = async () => {
    h.epoch++;
    store.wipe();
    h.runningTraces.clear();
    seed();
    await registerShopVersion();
    h.activity('run', 'Reset to factory: the healer and the shop start again from version 0');
    h.changed(...ALL_KINDS);
  };

  const follower = followShop({
    shop: options.shop,
    cursor: () => store.cursor(),
    handle: (event) => handleShopEvent(h, event, resetLocal),
    setConnected: (connected) => {
      if (connected === h.shopConnected) return;
      h.shopConnected = connected;
      if (!connected) h.runningTraces.clear();
      h.scheduleOverview();
    },
    onOpen: async () => {
      h.shopToday = (await options.shop.env()).today;
      await registerShopVersion();
    },
    onError: (err) => console.error('[healer] shop link:', err instanceof Error ? err.message : err),
    ...(options.reconnectMinMs ? { minDelayMs: options.reconnectMinMs } : {}),
  });

  const requireKey = () => {
    if (!h.hasLlm()) throw new HttpError(503, 'missing_api_key', 'No ANTHROPIC_API_KEY is set');
  };
  const requireLive = () => {
    const live = store.liveVersion();
    if (!live) throw new HttpError(503, 'shop_unreachable', 'No version is registered yet: the shop has not been reached');
    return live;
  };
  const shopCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new HttpError(502, 'shop_unreachable', err instanceof Error ? err.message : String(err));
    }
  };

  const evalView = (c: EvalCase): EvalCaseView => ({ case: c, history: caseHistory(h, c.id) });

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status);
    if (err instanceof MissingKeyError) return c.json({ error: 'missing_api_key', message: err.message }, 503);
    console.error('[healer]', err);
    return c.json({ error: 'internal', message: err.message }, 500);
  });

  app.notFound((c) => c.json({ error: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` }, 404));

  // ── Console plumbing ──

  app.get('/api/healer/overview', (c) => c.json<Res<'GET /api/healer/overview'>>(h.overview()));

  app.get('/api/healer/stream', (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: unknown) => void stream.writeSSE({ data: JSON.stringify(event) });
      send({ type: 'overview', overview: h.overview() });
      const unsubscribe = h.subscribe(send);
      const keepAlive = setInterval(() => void stream.write(': keep-alive\n\n'), options.keepAliveMs ?? 15_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(keepAlive);
      unsubscribe();
    }),
  );

  app.get('/api/healer/graphs', (c) => c.json<Res<'GET /api/healer/graphs'>>({ loop: loopGraphShape, agent: agentGraphShape }));

  app.get('/api/healer/activity', (c) => {
    const { limit } = query(c, z.object({ limit: limitParam }));
    return c.json<Res<'GET /api/healer/activity'>>(store.activity.latest(limit ?? 100));
  });

  app.get('/api/healer/lineage', (c) => {
    const q = query(c, z.object({ kind: z.enum(REF_KINDS), id: z.string().min(1) }));
    return c.json<Res<'GET /api/healer/lineage'>>(lineage(store, q.kind, q.id));
  });

  app.get('/api/healer/settings', (c) => c.json<Res<'GET /api/healer/settings'>>(store.settings()));

  app.put('/api/healer/settings', async (c) => {
    const patch = await body(
      c,
      z.object({
        autonomy: z.enum(['manual', 'approve', 'auto']).optional(),
        trialsPerCase: z.number().int().min(1).max(9).optional(),
        strictTrials: z.number().int().min(3).max(20).optional(),
      }),
    );
    const settings = { ...store.settings(), ...patch };
    store.setSettings(settings);
    h.activity(null, `Autonomy ${settings.autonomy}, ${settings.trialsPerCase} trials per eval case, ${settings.strictTrials} for strict cases when the model changes`);
    h.scheduleOverview();
    return c.json<Res<'PUT /api/healer/settings'>>(settings);
  });

  app.get('/api/healer/cost', (c) => c.json<Res<'GET /api/healer/cost'>>(store.costByRole()));

  app.get('/api/healer/jobs', (c) => c.json<Res<'GET /api/healer/jobs'>>(store.jobs.latest(100)));

  app.post('/api/healer/reset', async (c) => {
    await follower.exclusive(async () => {
      await shopCall(() => options.shop.reset());
      await resetLocal();
      const events = await shopCall(() => options.shop.events(0));
      store.setCursor(events.at(-1)?.seq ?? 0);
    });
    return c.json<Res<'POST /api/healer/reset'>>({ ok: true });
  });

  // ── Run and traces ──

  app.get('/api/healer/customers', async (c) => c.json<Res<'GET /api/healer/customers'>>(await shopCall(() => options.shop.customers())));

  app.get('/api/healer/traces', (c) => {
    const q = query(
      c,
      z.object({
        source: z.enum(['shop', 'simulator', 'seed', 'eval', 'redteam', 'replay']).optional(),
        verdict: z.enum(['pass', 'fail', 'pending']).optional(),
        versionId: z.coerce.number().int().optional(),
        customerId: z.string().optional(),
        limit: limitParam,
      }),
    );
    let list: TraceSummary[] = store.traceSummaries({ source: q.source, versionId: q.versionId, customerId: q.customerId });
    if (!q.source) list = list.filter((t) => !SANDBOX_SOURCES.includes(t.source));
    if (q.verdict) list = list.filter((t) => t.verdict === q.verdict);
    return c.json<Res<'GET /api/healer/traces'>>(list.slice(0, q.limit ?? 200));
  });

  // Registered before the :id route, which would otherwise take "sources" as a trace id.
  app.get('/api/healer/traces/sources', (c) => c.json<Res<'GET /api/healer/traces/sources'>>(store.traceCountsBySource()));

  app.get('/api/healer/traces/:id', (c) => {
    const trace = store.trace(c.req.param('id'));
    if (!trace) throw notFound('Trace');
    return c.json<Res<'GET /api/healer/traces/:id'>>({ trace, verdict: store.verdictForTrace(trace.id), rating: store.rating(trace.id), lineage: lineage(store, 'trace', trace.id) });
  });

  app.get('/api/healer/threads/:id', (c) =>
    c.json<Res<'GET /api/healer/threads/:id'>>(store.traceSummaries({ threadId: c.req.param('id') }).reverse()),
  );

  // ── Judge ──

  app.get('/api/healer/rules', (c) => c.json<Res<'GET /api/healer/rules'>>(POLICY_RULES));

  app.get('/api/healer/verdicts', (c) => {
    const q = query(c, z.object({ passed: z.enum(['true', 'false']).optional(), limit: limitParam }));
    return c.json<Res<'GET /api/healer/verdicts'>>(store.verdicts({ ...(q.passed ? { passed: q.passed === 'true' } : {}), limit: q.limit ?? 200 }));
  });

  app.get('/api/healer/verdicts/:id', (c) => {
    const verdict = store.verdict(c.req.param('id'));
    if (!verdict) throw notFound('Verdict');
    return c.json<Res<'GET /api/healer/verdicts/:id'>>({ verdict, lineage: lineage(store, 'verdict', verdict.id) });
  });

  app.post('/api/healer/traces/:id/judge', async (c) => {
    const trace = store.trace(c.req.param('id'));
    if (!trace) throw notFound('Trace');
    if (trace.source === 'eval') throw conflict('Eval traces are graded by their eval case, not judged');
    requireKey();
    const { verdict } = await h.stage('judge', 'Judge a trace', () => judgeTrace(h, trace));
    return c.json<Res<'POST /api/healer/traces/:id/judge'>>(verdict);
  });

  // ── Diagnose ──

  app.get('/api/healer/issues', (c) => c.json<Res<'GET /api/healer/issues'>>(store.issues.list().reverse()));

  app.get('/api/healer/issues/:id', (c) => {
    const issue = store.issues.get(c.req.param('id'));
    if (!issue) throw notFound('Issue');
    return c.json<Res<'GET /api/healer/issues/:id'>>({ issue, lineage: lineage(store, 'issue', issue.id) });
  });

  app.post('/api/healer/diagnose', (c) => {
    requireKey();
    requireLive();
    return c.json<Res<'POST /api/healer/diagnose'>>(startDiagnoseJob(h));
  });

  app.post('/api/healer/issues/:id/dismiss', (c) => {
    const issue = store.issues.get(c.req.param('id'));
    if (!issue) throw notFound('Issue');
    const dismissed: Issue = { ...issue, status: 'dismissed', updatedAt: now() };
    store.issues.put(dismissed);
    h.activity('diagnose', `Dismissed issue: ${issue.title}`, { kind: 'issue', id: issue.id, label: issue.title });
    h.changed('issue');
    return c.json<Res<'POST /api/healer/issues/:id/dismiss'>>(dismissed);
  });

  // ── Propose ──

  app.get('/api/healer/proposals', (c) => c.json<Res<'GET /api/healer/proposals'>>(store.proposals.list().reverse()));

  app.get('/api/healer/proposals/:id', (c) => {
    const proposal = store.proposals.get(c.req.param('id'));
    if (!proposal) throw notFound('Proposal');
    return c.json<Res<'GET /api/healer/proposals/:id'>>({
      proposal,
      base: store.versions.get(proposal.baseVersionId)!,
      candidate: store.versions.get(proposal.candidateVersionId)!,
      gateRun: proposal.gateRunId ? store.gateRuns.get(proposal.gateRunId) : null,
      lineage: lineage(store, 'proposal', proposal.id),
    });
  });

  app.post('/api/healer/issues/:id/propose', (c) => {
    const issue = store.issues.get(c.req.param('id'));
    if (!issue) throw notFound('Issue');
    if (issue.status === 'dismissed' || issue.status === 'fixed') throw conflict(`Issue ${issue.id} is ${issue.status}`);
    if (issue.proposalIds.some((id) => isOpenProposal(store.proposals.get(id)!))) throw conflict(`Issue ${issue.id} already has an open proposal`);
    if (issue.surface !== 'model') requireKey();
    requireLive();
    return c.json<Res<'POST /api/healer/issues/:id/propose'>>(startProposeJob(h, issue.id));
  });

  app.post('/api/healer/proposals', async (c) => {
    const input = await body(c, z.object({ title: z.string().min(1), rationale: z.string(), changes: z.array(changeSchema).min(1) }));
    requireLive();
    try {
      const proposal = createProposal(h, { author: 'human', issueId: null, title: input.title, rationale: input.rationale, changes: input.changes, proposeRun: null });
      return c.json<Res<'POST /api/healer/proposals'>>(proposal);
    } catch (err) {
      if (err instanceof ChangeError) throw new HttpError(400, 'invalid_input', err.message);
      throw err;
    }
  });

  app.post('/api/healer/proposals/:id/gate', (c) => {
    const proposal = store.proposals.get(c.req.param('id'));
    if (!proposal) throw notFound('Proposal');
    if (proposal.status !== 'draft') throw conflict(`Proposal ${proposal.id} is ${proposal.status}; only a draft can be gated`);
    requireKey();
    return c.json<Res<'POST /api/healer/proposals/:id/gate'>>(startGateJob(h, proposal.id));
  });

  app.post('/api/healer/proposals/:id/again', (c) => {
    const proposal = store.proposals.get(c.req.param('id'));
    if (!proposal) throw notFound('Proposal');
    if (proposal.status !== 'rejected') throw conflict(`Proposal ${proposal.id} is ${proposal.status}; only a rejected proposal can be proposed again`);
    const issue = proposal.issueId ? store.issues.get(proposal.issueId) : null;
    if (issue && (issue.status === 'fixed' || issue.status === 'dismissed')) throw conflict(`Its issue is already ${issue.status}`);
    if (issue?.proposalIds.some((id) => isOpenProposal(store.proposals.get(id)!))) throw conflict('Its issue already has an open proposal');
    requireLive();
    try {
      return c.json<Res<'POST /api/healer/proposals/:id/again'>>(proposeAgain(h, proposal, 'Proposed again'));
    } catch (err) {
      if (err instanceof ChangeError) throw conflict(err.message);
      throw err;
    }
  });

  app.post('/api/healer/proposals/:id/approve', async (c) => {
    const proposal = store.proposals.get(c.req.param('id'));
    if (!proposal) throw notFound('Proposal');
    if (proposal.status !== 'awaiting_approval') throw conflict(`Proposal ${proposal.id} is ${proposal.status}; only one awaiting approval can be promoted`);
    if (store.liveVersion()?.id !== proposal.baseVersionId) throw conflict(`Proposal ${proposal.id} was gated against version ${proposal.baseVersionId}, which is no longer live`);
    const version = await h.stage('promote', 'Promote a version', () => shopCall(() => approve(h, proposal.id)));
    return c.json<Res<'POST /api/healer/proposals/:id/approve'>>(version);
  });

  app.post('/api/healer/proposals/:id/discard', (c) => {
    const proposal = store.proposals.get(c.req.param('id'));
    if (!proposal) throw notFound('Proposal');
    if (!isOpenProposal(proposal) || proposal.status === 'gating') throw conflict(`Proposal ${proposal.id} is ${proposal.status} and cannot be discarded`);
    return c.json<Res<'POST /api/healer/proposals/:id/discard'>>(discardProposal(h, proposal));
  });

  // ── Gate ──

  app.get('/api/healer/gate-runs', (c) => c.json<Res<'GET /api/healer/gate-runs'>>(store.gateRuns.list().reverse()));

  app.get('/api/healer/gate-runs/:id', (c) => {
    const gateRun = store.gateRuns.get(c.req.param('id'));
    if (!gateRun) throw notFound('Gate run');
    return c.json<Res<'GET /api/healer/gate-runs/:id'>>({
      gateRun,
      baseRun: gateRun.baseRunId ? store.evalRuns.get(gateRun.baseRunId) : null,
      candidateRun: gateRun.candidateRunId ? store.evalRuns.get(gateRun.candidateRunId) : null,
      lineage: lineage(store, 'gateRun', gateRun.id),
    });
  });

  // ── Surfaces ──

  app.get('/api/healer/versions', (c) => c.json<Res<'GET /api/healer/versions'>>(store.versions.list().sort((a, b) => a.id - b.id)));

  app.get('/api/healer/versions/:id', (c) => {
    const version = store.versions.get(c.req.param('id'));
    if (!version) throw notFound('Version');
    const latestRun = store.evalRuns.list().filter((r) => r.versionId === version.id && r.status === 'done').at(-1) ?? null;
    return c.json<Res<'GET /api/healer/versions/:id'>>({
      version,
      parent: version.parentId === null ? null : store.versions.get(version.parentId),
      latestRun,
      lineage: lineage(store, 'version', String(version.id)),
    });
  });

  app.post('/api/healer/versions/:id/rollback', async (c) => {
    const version = store.versions.get(c.req.param('id'));
    if (!version) throw notFound('Version');
    requireLive();
    return c.json<Res<'POST /api/healer/versions/:id/rollback'>>(await h.stage('promote', 'Roll back', () => shopCall(() => rollback(h, version.id))));
  });

  app.get('/api/healer/model', (c) =>
    c.json<Res<'GET /api/healer/model'>>({ live: requireLive().model, pricing: PRICING, routers: store.routers(), dataset: store.routerDataset() }),
  );

  app.post('/api/healer/model/tier', async (c) => {
    const { tier } = await body(c, z.object({ tier: z.enum(['haiku', 'sonnet', 'opus']) }));
    requireLive();
    return c.json<Res<'POST /api/healer/model/tier'>>(await h.stage('promote', 'Switch model tier', () => shopCall(() => setTier(h, tier))));
  });

  app.post('/api/healer/model/router/dataset', async (c) => {
    const { maxExamples } = await body(c, z.object({ maxExamples: z.number().int().min(1).max(200) }));
    requireKey();
    requireLive();
    return c.json<Res<'POST /api/healer/model/router/dataset'>>(startDatasetJob(h, maxExamples));
  });

  app.post('/api/healer/model/router/train', async (c) => {
    const dataset = store.routerDataset();
    if (!dataset.some((e) => e.needsStrong)) {
      throw conflict(
        `The dataset has no requests that carry risk yet: in none of its ${dataset.length} examples did haiku fail where the stronger tier kept every rule, a replay attempt a refund or a cancellation, or the judge read a request for one in the original conversation. Send traffic that asks for refunds or cancellations, such as the seeded cases or more simulated customers, then build the dataset again.`,
      );
    }
    return c.json<Res<'POST /api/healer/model/router/train'>>(await trainAndStore(h));
  });

  app.post('/api/healer/model/router/:id/propose', (c) => {
    const router = store.routers().find((r) => r.id === c.req.param('id'));
    if (!router) throw notFound('Router');
    requireLive();
    return c.json<Res<'POST /api/healer/model/router/:id/propose'>>(proposeRouter(h, router));
  });

  // ── Eval suite ──

  app.get('/api/healer/evals', (c) => c.json<Res<'GET /api/healer/evals'>>(store.evalCases.list().map(evalView)));

  app.get('/api/healer/evals/:id', (c) => {
    const evalCase = store.evalCases.get(c.req.param('id'));
    if (!evalCase) throw notFound('Eval case');
    return c.json<Res<'GET /api/healer/evals/:id'>>({ ...evalView(evalCase), lineage: lineage(store, 'evalCase', evalCase.id) });
  });

  const checksSchema = z
    .array(checkSpecSchema)
    .min(1)
    .refine((checks) => new Set(checks.map((x) => x.id)).size === checks.length, 'Check ids must be unique');

  app.post('/api/healer/evals', async (c) => {
    const input = await body(c, z.object({ title: z.string().min(1), customerId: z.string().min(1), message: z.string().min(1), checks: checksSchema }));
    const env = seedSnapshot();
    if (!env.customers.some((x) => x.id === input.customerId)) throw new HttpError(400, 'invalid_input', `Unknown customer ${input.customerId}`);
    // Hand-written cases start from the seed records, so they replay the same way every time.
    const evalCase: EvalCase = {
      id: newId('ev'),
      createdAt: now(),
      title: input.title,
      origin: 'human',
      sourceTraceId: null,
      issueId: null,
      customerId: input.customerId,
      history: [],
      message: input.message,
      env,
      checks: input.checks as EvalCase['checks'],
      enabled: true,
      strict: isStrictCase(input.checks as EvalCase['checks'], null),
      validation: null,
    };
    store.evalCases.put(evalCase);
    h.activity('gate', `New eval case written by hand: ${evalCase.title}`, { kind: 'evalCase', id: evalCase.id, label: evalCase.title });
    h.changed('evalCase');
    return c.json<Res<'POST /api/healer/evals'>>(evalCase);
  });

  app.patch('/api/healer/evals/:id', async (c) => {
    const evalCase = store.evalCases.get(c.req.param('id'));
    if (!evalCase) throw notFound('Eval case');
    const patch = await body(
      c,
      z.object({
        title: z.string().min(1).optional(),
        checks: checksSchema.optional(),
        enabled: z.boolean().optional(),
        strict: z.boolean().optional(),
        validation: caseValidationSchema.nullable().optional(),
      }),
    );
    const updated = store.evalCases.put({ ...evalCase, ...(patch as Partial<EvalCase>) });
    if (patch.checks) store.markChecksEdited(evalCase.id, now());
    h.changed('evalCase');
    return c.json<Res<'PATCH /api/healer/evals/:id'>>(updated);
  });

  app.post('/api/healer/evals/:id/validate', (c) => {
    const evalCase = store.evalCases.get(c.req.param('id'));
    if (!evalCase) throw notFound('Eval case');
    requireKey();
    requireLive();
    return c.json<Res<'POST /api/healer/evals/:id/validate'>>(startValidateJob(h, evalCase.id));
  });

  app.post('/api/healer/evals/run', async (c) => {
    const { versionId } = await body(c, z.object({ versionId: z.number().int() }));
    if (!store.versions.get(versionId)) throw notFound('Version');
    requireKey();
    return c.json<Res<'POST /api/healer/evals/run'>>(startEvalJob(h, versionId));
  });

  app.get('/api/healer/eval-runs', (c) => c.json<Res<'GET /api/healer/eval-runs'>>(store.evalRuns.list().reverse()));

  app.get('/api/healer/eval-runs/:id', (c) => {
    const run = store.evalRuns.get(c.req.param('id'));
    if (!run) throw notFound('Eval run');
    return c.json<Res<'GET /api/healer/eval-runs/:id'>>(run);
  });

  // ── Traffic ──

  app.get('/api/healer/seeds', (c) => c.json<Res<'GET /api/healer/seeds'>>(SEEDED_CASES));

  app.post('/api/healer/seeds/:id/fire', (c) => {
    const seed = SEEDED_CASES.find((s) => s.id === c.req.param('id'));
    if (!seed) throw notFound('Seeded case');
    requireKey();
    return c.json<Res<'POST /api/healer/seeds/:id/fire'>>(startFireJob(h, seed));
  });

  app.post('/api/healer/simulate', async (c) => {
    const { count } = await body(c, z.object({ count: z.number().int().min(1).max(100) }));
    requireKey();
    return c.json<Res<'POST /api/healer/simulate'>>(startSimulateJob(h, count));
  });

  app.post('/api/healer/redteam', async (c) => {
    const { count } = await body(c, z.object({ count: z.number().int().min(1).max(20) }));
    requireKey();
    requireLive();
    return c.json<Res<'POST /api/healer/redteam'>>(startRedTeamJob(h, count));
  });

  app.get('/api/healer/findings', (c) => c.json<Res<'GET /api/healer/findings'>>(store.findings.list().reverse()));


  return {
    app,
    healer: h,
    store,
    // Seeds the golden cases on first start and starts following the shop.
    start: () => {
      for (const job of store.jobs.list()) {
        if (job.status === 'running') store.jobs.put({ ...job, status: 'failed', endedAt: now(), error: 'The healer restarted while this job was running' });
      }
      for (const run of store.evalRuns.list()) if (run.status === 'running') store.evalRuns.put({ ...run, status: 'failed', endedAt: now() });
      for (const p of store.proposals.list()) if (p.status === 'gating') store.proposals.put({ ...p, status: 'draft' });
      seed();
      // Traces ingested but not yet judged when the healer last stopped.
      for (const t of store.traceSummaries().reverse()) if (!SANDBOX_SOURCES.includes(t.source) && t.verdict === 'pending') void runLoop(h, t.id);
      follower.start();
    },
    close: () => {
      follower.stop();
      h.close();
      store.close();
    },
  };
}
