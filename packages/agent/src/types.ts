// Shared contract. The shop service, the healer service, and the web app all import from here.

// ── Models ────────────────────────────────────────────────────────────────

export type Tier = 'haiku' | 'sonnet' | 'opus';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const TIER_MODEL_ID: Record<Tier, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
};

// Held fixed across agent versions: if the judge changed, scores would stop being comparable.
export const LOOP_MODEL_ID = 'claude-opus-5-5';
export const SIMULATOR_MODEL_ID = 'claude-haiku-5-5';

export type LlmRole = 'agent' | 'judge' | 'diagnose' | 'propose' | 'redteam' | 'simulator';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// One recorded step. `input` and `output` hold the exact payloads so the console can show raw workings.
export interface Run {
  id: string;
  parentId: string | null;
  kind: 'node' | 'model' | 'tool';
  name: string;
  role?: LlmRole;
  model?: string;
  startedAt: string;
  endedAt: string;
  input: unknown;
  output: unknown;
  error?: string;
  usage?: Usage;
}

export interface GraphShape {
  id: string;
  entry: string;
  nodes: { id: string; label: string; description: string }[];
  edges: { from: string; to: string; label?: string }[];
}

// ── The shop world ────────────────────────────────────────────────────────

export interface Customer {
  id: string;
  name: string;
  email: string;
  memberSince: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
  opened: boolean;
  finalSale: boolean;
}

export type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'cancelled';

export interface Order {
  id: string;
  customerId: string;
  items: OrderItem[];
  discountPct: number;
  shippingFee: number;
  totalPaid: number;
  status: OrderStatus;
  placedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  shippingAddress: string;
  paymentMethod: 'card' | 'store_credit';
}

export interface Refund {
  id: string;
  orderId: string;
  amount: number;
  method: 'original_payment' | 'store_credit';
  reason: string;
  createdAt: string;
}

export interface Escalation {
  id: string;
  customerId: string;
  orderId: string | null;
  reason: string;
  createdAt: string;
}

// The whole shop world. Small enough to copy, which is how sandboxes and eval cases get their starting state.
export interface EnvSnapshot {
  today: string;
  customers: Customer[];
  orders: Order[];
  refunds: Refund[];
  escalations: Escalation[];
}

// ── The agent: three surfaces, versioned together ─────────────────────────

export type Scope = { kind: 'shop' } | { kind: 'customer'; customerId: string };

export interface MemoryNote {
  id: string;
  scope: Scope;
  text: string;
  addedInVersion: number;
  issueId: string | null;
}

export type ToolName =
  | 'list_orders'
  | 'get_order'
  | 'issue_refund'
  | 'cancel_order'
  | 'update_shipping_address'
  | 'escalate_to_human';

export interface ToolConfig {
  name: ToolName;
  description: string;
  enabled: boolean;
}

// Checks enforced in tool code, not by the model. All off in the factory version.
export interface Guards {
  requireOrderLookupBeforeWrite: boolean;
  blockDuplicateRefund: boolean;
  refundEscalationThreshold: number | null;
}

export interface HarnessConfig {
  systemPrompt: string;
  tools: ToolConfig[];
  guards: Guards;
  maxSteps: number;
}

export interface RouterModel {
  id: string;
  createdAt: string;
  vocabulary: string[];
  weights: number[];
  bias: number;
  threshold: number;
  metrics: {
    trainSize: number;
    valSize: number;
    trainAccuracy: number;
    valAccuracy: number;
    lossCurve: number[];
    trainPositives: number;
    valPositives: number;
    // Share of validation examples that needed the strong model and were routed to it; null when there are none.
    valRecall: number | null;
  };
}

export type ModelConfig =
  | { mode: 'fixed'; tier: Tier; effort: Effort }
  | { mode: 'routed'; easyTier: Tier; hardTier: Tier; effort: Effort; router: RouterModel };

export type VersionStatus = 'candidate' | 'live' | 'superseded' | 'rejected';

export interface AgentVersion {
  id: number;
  parentId: number | null;
  createdAt: string;
  author: 'factory' | 'loop' | 'human';
  summary: string;
  status: VersionStatus;
  proposalId: string | null;
  // False when a human deployed it without running the eval gate.
  gated: boolean;
  context: MemoryNote[];
  harness: HarnessConfig;
  model: ModelConfig;
}

// ── Traces ────────────────────────────────────────────────────────────────

export type TraceSource = 'shop' | 'simulator' | 'seed' | 'eval' | 'redteam' | 'replay';
export type Rating = 'up' | 'down';

export interface ChatTurn {
  role: 'customer' | 'agent';
  text: string;
}

export interface ToolCallRecord {
  runId: string;
  name: ToolName;
  input: Record<string, unknown>;
  output: unknown;
  blockedByGuard: keyof Guards | null;
}

// One customer message handled by the agent. A thread is the list of traces sharing a threadId.
export interface Trace {
  id: string;
  threadId: string;
  customerId: string;
  versionId: number;
  source: TraceSource;
  startedAt: string;
  endedAt: string;
  history: ChatTurn[];
  input: string;
  output: string;
  tierUsed: Tier;
  routerDecision: { score: number; needsStrong: boolean } | null;
  runs: Run[];
  toolCalls: ToolCallRecord[];
  envBefore: EnvSnapshot;
  envAfter: EnvSnapshot;
  usage: Usage;
  error?: string;
}

export interface TraceSummary {
  id: string;
  threadId: string;
  customerId: string;
  versionId: number;
  source: TraceSource;
  startedAt: string;
  input: string;
  output: string;
  tierUsed: Tier;
  costUsd: number;
  verdict: 'pass' | 'fail' | 'pending';
  rating: Rating | null;
}

// ── Judging ───────────────────────────────────────────────────────────────

export type CheckKind =
  | 'invariant'
  | 'end_state'
  | 'tool_sequence'
  | 'exact_match'
  | 'rubric'
  | 'feedback'
  | 'consistency';

// A shop policy checked in code against any trace. Together these are "the PRD": the agent is never shown them.
export interface PolicyRule {
  id: string;
  label: string;
  description: string;
}

// `params` is interpreted by the healer per kind. The console shows `label` and prints `params` as-is.
export interface EvalCheckSpec {
  id: string;
  kind: CheckKind;
  label: string;
  params: Record<string, unknown>;
}

export interface CheckResult {
  checkId: string;
  kind: CheckKind;
  label: string;
  passed: boolean;
  detail: string;
}

export interface Verdict {
  id: string;
  traceId: string;
  createdAt: string;
  passed: boolean;
  checks: CheckResult[];
  judgeRun: Run | null;
}

// ── Diagnosis and proposals ───────────────────────────────────────────────

export type Cause = 'knowledge' | 'process' | 'capability';
export type Surface = 'context' | 'harness' | 'model';

export interface Issue {
  id: string;
  // A preference is filed by the judge for one customer; a failure is filed by diagnosis with an eval case.
  kind: 'failure' | 'preference';
  createdAt: string;
  updatedAt: string;
  title: string;
  summary: string;
  cause: Cause;
  surface: Surface;
  scope: Scope;
  status: 'open' | 'proposed' | 'fixed' | 'dismissed';
  traceIds: string[];
  evalCaseIds: string[];
  proposalIds: string[];
  diagnoseRun: Run | null;
}

export type Change =
  | { surface: 'context'; op: 'add'; scope: Scope; text: string }
  | { surface: 'context'; op: 'edit'; noteId: string; text: string }
  | { surface: 'context'; op: 'remove'; noteId: string }
  | { surface: 'harness'; op: 'set_system_prompt'; systemPrompt: string }
  | { surface: 'harness'; op: 'set_tool'; name: ToolName; description?: string; enabled?: boolean }
  | { surface: 'harness'; op: 'set_guards'; guards: Partial<Guards> }
  | { surface: 'model'; op: 'set_model'; model: ModelConfig };

export type ProposalStatus =
  | 'draft'
  | 'gating'
  | 'awaiting_approval'
  | 'rejected'
  | 'promoted'
  | 'discarded';

export interface Proposal {
  id: string;
  createdAt: string;
  author: 'loop' | 'human';
  issueId: string | null;
  title: string;
  rationale: string;
  baseVersionId: number;
  candidateVersionId: number;
  changes: Change[];
  status: ProposalStatus;
  gateRunId: string | null;
  proposeRun: Run | null;
}

// ── Evals and the gate ────────────────────────────────────────────────────

export interface EvalCase {
  id: string;
  createdAt: string;
  title: string;
  origin: 'golden' | 'failure' | 'redteam' | 'human';
  sourceTraceId: string | null;
  issueId: string | null;
  customerId: string;
  history: ChatTurn[];
  message: string;
  env: EnvSnapshot;
  checks: EvalCheckSpec[];
  enabled: boolean;
}

export interface TrialResult {
  traceId: string;
  passed: boolean;
  checks: CheckResult[];
  costUsd: number;
}

export interface CaseResult {
  caseId: string;
  trials: TrialResult[];
  passRate: number;
  // Majority of trials passed.
  passed: boolean;
}

export interface EvalRun {
  id: string;
  versionId: number;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt: string | null;
  trialsPerCase: number;
  results: CaseResult[];
  passRate: number;
  costPerTaskUsd: number;
  totalCostUsd: number;
}

export interface GateRun {
  id: string;
  createdAt: string;
  proposalId: string;
  baseVersionId: number;
  candidateVersionId: number;
  baseRunId: string | null;
  candidateRunId: string | null;
  fixedCaseIds: string[];
  regressedCaseIds: string[];
  decision: 'pending' | 'accept' | 'reject';
  reasons: string[];
}

// ── Router training ───────────────────────────────────────────────────────

// One request replayed on both tiers. It needs the strong model when it carries risk: a replay attempted a tool that
// moves money or cannot be undone, or the easy tier failed where the hard tier passed.
export interface RouterExample {
  id: string;
  text: string;
  needsStrong: boolean;
  // Measured failure wins when both apply, since it is the stronger evidence. Null when the small model is enough.
  reason: 'high_stakes' | 'measured_failure' | null;
  split: 'train' | 'val';
  easyTraceId: string;
  hardTraceId: string;
  easyPassed: boolean;
  hardPassed: boolean;
}

// ── Traffic and red teaming ───────────────────────────────────────────────

export interface SeededCase {
  id: string;
  title: string;
  teaches: string;
  customerId: string;
  messages: string[];
}

export interface RedTeamFinding {
  id: string;
  createdAt: string;
  customerId: string;
  original: { message: string; traceId: string };
  paraphrase: { message: string; traceId: string };
  consistent: boolean;
  differences: string[];
  compareRun: Run | null;
  issueId: string | null;
}

// ── Console plumbing ──────────────────────────────────────────────────────

export type LoopStage = 'run' | 'judge' | 'diagnose' | 'propose' | 'gate' | 'promote';
export type Autonomy = 'manual' | 'approve' | 'auto';

export interface Settings {
  autonomy: Autonomy;
  trialsPerCase: number;
}

export interface Job {
  id: string;
  kind:
    | 'simulate'
    | 'redteam'
    | 'eval'
    | 'gate'
    | 'diagnose'
    | 'propose'
    | 'router_dataset'
    | 'router_train';
  label: string;
  status: 'running' | 'done' | 'failed';
  progress: { done: number; total: number };
  startedAt: string;
  endedAt: string | null;
  error?: string;
  // What the job belongs to: gate → proposal id, propose → issue id, eval → eval run id, diagnose → null.
  refId: string | null;
}

export interface CostByRole {
  role: LlmRole;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Overview {
  shopConnected: boolean;
  // The shop's fixed "today", read from its records; null until the shop has been reached.
  shopToday: string | null;
  apiKeyPresent: boolean;
  liveVersionId: number;
  liveModel: ModelConfig;
  settings: Settings;
  activeStages: LoopStage[];
  counts: {
    // Customer traces only; the healer's own sandbox runs are in sandboxTraces.
    traces: number;
    sandboxTraces: number;
    verdictsPassed: number;
    verdictsFailed: number;
    issuesOpen: number;
    issuesTotal: number;
    proposalsAwaitingApproval: number;
    proposalsTotal: number;
    gateRunsAccepted: number;
    gateRunsRejected: number;
    versions: number;
    contextNotes: number;
    evalCases: number;
    routerExamples: number;
  };
  latestPassRate: number | null;
  cost: { totalUsd: number; byRole: CostByRole[] };
}

export type RefKind =
  | 'trace'
  | 'verdict'
  | 'issue'
  | 'proposal'
  | 'gateRun'
  | 'version'
  | 'evalCase'
  | 'evalRun'
  | 'finding';

export interface Ref {
  kind: RefKind;
  id: string;
  label: string;
}

// The chain around any one object, so a failure can be followed from customer message to the version that fixed it.
export interface Lineage {
  traces: Ref[];
  verdicts: Ref[];
  issues: Ref[];
  proposals: Ref[];
  gateRuns: Ref[];
  versions: Ref[];
  evalCases: Ref[];
}

export interface ActivityEntry {
  id: string;
  at: string;
  // Null for entries that belong to no stage, such as a settings change.
  stage: LoopStage | null;
  text: string;
  ref: Ref | null;
}
