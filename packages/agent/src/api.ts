// HTTP contract. Keys are "METHOD path"; services implement them and the web client is typed from them.

import type {
  ActivityEntry,
  AgentVersion,
  ChatTurn,
  Change,
  CostByRole,
  Customer,
  EnvSnapshot,
  EvalCase,
  EvalCheckSpec,
  EvalRun,
  GateRun,
  GraphShape,
  Issue,
  Job,
  Lineage,
  LoopStage,
  Order,
  Overview,
  PolicyRule,
  Proposal,
  Rating,
  RedTeamFinding,
  RefKind,
  RouterExample,
  RouterModel,
  SeededCase,
  Settings,
  Tier,
  Trace,
  TraceSource,
  TraceSummary,
  Verdict,
} from './types.ts';

export const PORTS = { web: 3000, shop: 4311, healer: 4312 } as const;

type Route<Res, Body = never, Query = never> = { res: Res; body: Body; query: Query };
type Ok = { ok: true };

// ── Shop service ──────────────────────────────────────────────────────────

export interface ThreadView {
  id: string;
  customerId: string;
  turns: (ChatTurn & { traceId: string | null; rating: Rating | null; at: string })[];
}

export type ShopEvent = { seq: number; at: string } & (
  | { type: 'trace.started'; traceId: string; threadId: string; customerId: string; source: TraceSource; message: string }
  | { type: 'trace.completed'; trace: Trace }
  | { type: 'feedback'; traceId: string; rating: Rating }
  | { type: 'deployment'; versionId: number }
  | { type: 'reset' }
);

export interface ShopApi {
  // The shop front.
  'GET /api/shop/customers': Route<Customer[]>;
  'GET /api/shop/customers/:id/orders': Route<Order[]>;
  'GET /api/shop/customers/:id/threads': Route<ThreadView[]>;
  'POST /api/shop/chat': Route<
    { threadId: string; traceId: string; reply: string },
    { customerId: string; threadId?: string; message: string; source?: TraceSource }
  >;
  'POST /api/shop/feedback': Route<Ok, { traceId: string; rating: Rating }>;

  // The headless side: everything the healer needs, and nothing that knows the healer exists.
  'GET /api/shop/events': Route<ShopEvent[], never, { after?: number }>;
  // Server-sent events, one ShopEvent per message.
  'GET /api/shop/events/stream': Route<ShopEvent>;
  'GET /api/shop/deployment': Route<AgentVersion>;
  'PUT /api/shop/deployment': Route<Ok, AgentVersion>;
  'GET /api/shop/env': Route<EnvSnapshot>;
  // Restores seed data, clears threads and events, redeploys the factory version.
  'POST /api/shop/reset': Route<Ok>;
}

// ── Healer service ────────────────────────────────────────────────────────

export type HealerEvent =
  | { type: 'overview'; overview: Overview }
  | { type: 'stage'; stage: LoopStage; state: 'started' | 'finished'; label: string }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'job'; job: Job }
  // Tells open pages which lists to refetch.
  | { type: 'changed'; kinds: RefKind[] };

export interface TraceDetail {
  trace: Trace;
  verdict: Verdict | null;
  rating: Rating | null;
  lineage: Lineage;
}

export interface VersionDetail {
  version: AgentVersion;
  parent: AgentVersion | null;
  latestRun: EvalRun | null;
  lineage: Lineage;
}

export interface EvalCaseView {
  case: EvalCase;
  // Most recent result per version that has run this case, oldest version first.
  history: { versionId: number; passRate: number; passed: boolean }[];
}

export interface ModelView {
  live: AgentVersion['model'];
  pricing: Record<Tier, { modelId: string; inputPerMTok: number; outputPerMTok: number }>;
  routers: RouterModel[];
  dataset: RouterExample[];
}

export interface HealerApi {
  // Map home.
  'GET /api/healer/overview': Route<Overview>;
  // Server-sent events, one HealerEvent per message.
  'GET /api/healer/stream': Route<HealerEvent>;
  'GET /api/healer/graphs': Route<{ loop: GraphShape; agent: GraphShape }>;
  'GET /api/healer/activity': Route<ActivityEntry[], never, { limit?: number }>;
  'GET /api/healer/lineage': Route<Lineage, never, { kind: RefKind; id: string }>;
  'GET /api/healer/settings': Route<Settings>;
  'PUT /api/healer/settings': Route<Settings, Partial<Settings>>;
  'GET /api/healer/cost': Route<{ totalUsd: number; byRole: CostByRole[] }>;
  'GET /api/healer/jobs': Route<Job[]>;
  // Clears the healer's own state, then resets the shop.
  'POST /api/healer/reset': Route<Ok>;

  // Run and traces.
  'GET /api/healer/customers': Route<Customer[]>;
  'GET /api/healer/traces': Route<
    TraceSummary[],
    never,
    { source?: TraceSource; verdict?: 'pass' | 'fail' | 'pending'; versionId?: number; limit?: number }
  >;
  'GET /api/healer/traces/:id': Route<TraceDetail>;
  'GET /api/healer/threads/:id': Route<TraceSummary[]>;

  // Judge.
  'GET /api/healer/rules': Route<PolicyRule[]>;
  'GET /api/healer/verdicts': Route<Verdict[], never, { passed?: boolean; limit?: number }>;
  'POST /api/healer/traces/:id/judge': Route<Verdict>;

  // Diagnose.
  'GET /api/healer/issues': Route<Issue[]>;
  'GET /api/healer/issues/:id': Route<{ issue: Issue; lineage: Lineage }>;
  // Clusters every failed verdict that has no issue yet.
  'POST /api/healer/diagnose': Route<Job>;
  'POST /api/healer/issues/:id/dismiss': Route<Issue>;

  // Propose.
  'GET /api/healer/proposals': Route<Proposal[]>;
  'GET /api/healer/proposals/:id': Route<{
    proposal: Proposal;
    base: AgentVersion;
    candidate: AgentVersion;
    gateRun: GateRun | null;
    lineage: Lineage;
  }>;
  'POST /api/healer/issues/:id/propose': Route<Job>;
  // A change written by hand in the console.
  'POST /api/healer/proposals': Route<Proposal, { title: string; rationale: string; changes: Change[] }>;
  'POST /api/healer/proposals/:id/gate': Route<Job>;
  // Promotes the candidate and deploys it to the shop.
  'POST /api/healer/proposals/:id/approve': Route<AgentVersion>;
  'POST /api/healer/proposals/:id/discard': Route<Proposal>;

  // Gate.
  'GET /api/healer/gate-runs': Route<GateRun[]>;
  'GET /api/healer/gate-runs/:id': Route<{
    gateRun: GateRun;
    baseRun: EvalRun | null;
    candidateRun: EvalRun | null;
    lineage: Lineage;
  }>;

  // Surfaces.
  'GET /api/healer/versions': Route<AgentVersion[]>;
  'GET /api/healer/versions/:id': Route<VersionDetail>;
  // Deploys a copy of an older version as the new live version.
  'POST /api/healer/versions/:id/rollback': Route<AgentVersion>;
  'GET /api/healer/model': Route<ModelView>;
  // Manual picker: deploys straight away, marked as not gated.
  'POST /api/healer/model/tier': Route<AgentVersion, { tier: Tier }>;
  'POST /api/healer/model/router/dataset': Route<Job, { maxExamples: number }>;
  'POST /api/healer/model/router/train': Route<RouterModel>;
  'POST /api/healer/model/router/:id/propose': Route<Proposal>;

  // Eval suite.
  'GET /api/healer/evals': Route<EvalCaseView[]>;
  'GET /api/healer/evals/:id': Route<EvalCaseView & { lineage: Lineage }>;
  'POST /api/healer/evals': Route<
    EvalCase,
    { title: string; customerId: string; message: string; checks: EvalCheckSpec[] }
  >;
  'PATCH /api/healer/evals/:id': Route<EvalCase, Partial<Pick<EvalCase, 'title' | 'checks' | 'enabled'>>>;
  'POST /api/healer/evals/run': Route<Job, { versionId: number }>;
  'GET /api/healer/eval-runs': Route<EvalRun[]>;
  'GET /api/healer/eval-runs/:id': Route<EvalRun>;

  // Traffic.
  'GET /api/healer/seeds': Route<SeededCase[]>;
  'POST /api/healer/seeds/:id/fire': Route<Job>;
  'POST /api/healer/simulate': Route<Job, { count: number }>;
  'POST /api/healer/redteam': Route<Job, { count: number }>;
  'GET /api/healer/findings': Route<RedTeamFinding[]>;
}
