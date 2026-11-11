import type {
  ActivityEntry,
  AgentVersion,
  CaseResult,
  ChatTurn,
  CostByRole,
  Customer,
  EnvSnapshot,
  EvalCase,
  EvalCheckSpec,
  EvalRun,
  GateRun,
  GraphShape,
  HarnessConfig,
  Issue,
  Job,
  Lineage,
  LlmRole,
  MemoryNote,
  Order,
  OrderItem,
  PolicyRule,
  Proposal,
  Rating,
  RedTeamFinding,
  Ref,
  RefKind,
  RouterExample,
  RouterModel,
  Run,
  SeededCase,
  Tier,
  ToolName,
  Trace,
  TraceSource,
  TraceSummary,
  Verdict,
  CheckResult,
  ThreadView,
} from '@healer/agent';

const MODEL: Record<Tier, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const PRICE: Record<Tier, [number, number]> = { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25] };

const at = (day: string, hm: string, s = 0) => `2026-${day}T${hm}:${String(s).padStart(2, '0')}.000Z`;
const addMs = (iso: string, msAdd: number) => new Date(new Date(iso).getTime() + msAdd).toISOString();
const clone = <T>(x: T): T => structuredClone(x);
const cost = (tier: Tier, inT: number, outT: number) => (inT * PRICE[tier][0] + outT * PRICE[tier][1]) / 1e6;

// ── World ─────────────────────────────────────────────────────────────────

export const customers: Customer[] = [
  { id: 'cus_maya', name: 'Maya Okafor', email: 'maya.okafor@example.com', memberSince: '2024-03-02' },
  { id: 'cus_tom', name: 'Tom Lindqvist', email: 'tom.l@example.com', memberSince: '2025-06-18' },
  { id: 'cus_priya', name: 'Priya Raman', email: 'priya.raman@example.com', memberSince: '2023-11-27' },
  { id: 'cus_jonas', name: 'Jonas Weber', email: 'jonas.weber@example.com', memberSince: '2026-01-09' },
];

const item = (sku: string, name: string, qty: number, unitPrice: number, opened = false, finalSale = false): OrderItem => ({
  sku,
  name,
  qty,
  unitPrice,
  opened,
  finalSale,
});

function order(o: Omit<Order, 'totalPaid'>): Order {
  const sub = o.items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  return { ...o, totalPaid: Math.round((sub * (1 - o.discountPct / 100) + o.shippingFee) * 100) / 100 };
}

export const orders: Order[] = [
  order({ id: 'ord_1001', customerId: 'cus_maya', items: [item('PM-WC9', 'Galvanised watering can, 9 litre', 1, 34), item('PM-HP3', 'Terracotta herb pots, set of 3', 1, 28)], discountPct: 0, shippingFee: 5.95, status: 'delivered', placedAt: '2026-09-14', shippedAt: '2026-09-16', deliveredAt: '2026-09-20', shippingAddress: '14 Alder Row, Bristol', paymentMethod: 'card' }),
  order({ id: 'ord_1002', customerId: 'cus_maya', items: [item('PM-LC2', 'Linen cushion cover, sage', 2, 24)], discountPct: 0, shippingFee: 0, status: 'delivered', placedAt: '2026-10-28', shippedAt: '2026-10-30', deliveredAt: '2026-11-02', shippingAddress: '14 Alder Row, Bristol', paymentMethod: 'card' }),
  order({ id: 'ord_1003', customerId: 'cus_tom', items: [item('PM-WT1', 'Wool throw, oat', 1, 89, true, true)], discountPct: 0, shippingFee: 0, status: 'delivered', placedAt: '2026-10-24', shippedAt: '2026-10-26', deliveredAt: '2026-10-30', shippingAddress: '3 Kestrel Lane, Leeds', paymentMethod: 'card' }),
  order({ id: 'ord_1004', customerId: 'cus_tom', items: [item('PM-BC3', 'Beeswax candle trio', 1, 22), item('PM-CM1', 'Copper plant mister', 1, 18)], discountPct: 0, shippingFee: 4.5, status: 'shipped', placedAt: '2026-11-07', shippedAt: '2026-11-09', deliveredAt: null, shippingAddress: '3 Kestrel Lane, Leeds', paymentMethod: 'store_credit' }),
  order({ id: 'ord_1005', customerId: 'cus_priya', items: [item('PM-ST1', 'Seed starter tray', 3, 12), item('PM-BL5', 'Bamboo plant labels, pack of 50', 1, 6)], discountPct: 0, shippingFee: 4.5, status: 'processing', placedAt: '2026-11-10', shippedAt: null, deliveredAt: null, shippingAddress: '88 Orchard Street, York', paymentMethod: 'card' }),
  order({ id: 'ord_1006', customerId: 'cus_priya', items: [item('PM-GK1', 'Folding garden kneeler', 1, 29, true)], discountPct: 10, shippingFee: 3.95, status: 'delivered', placedAt: '2026-10-19', shippedAt: '2026-10-21', deliveredAt: '2026-10-25', shippingAddress: '88 Orchard Street, York', paymentMethod: 'card' }),
  order({ id: 'ord_1007', customerId: 'cus_jonas', items: [item('PM-BC1', 'Garden bench cushion', 1, 64)], discountPct: 0, shippingFee: 0, status: 'cancelled', placedAt: '2026-10-02', shippedAt: null, deliveredAt: null, shippingAddress: '7 Weir Close, Bath', paymentMethod: 'card' }),
  order({ id: 'ord_1008', customerId: 'cus_jonas', items: [item('PM-RP1', 'Rattan planter, large', 1, 75), item('PM-JD1', 'Jute doormat', 1, 32)], discountPct: 15, shippingFee: 6.5, status: 'delivered', placedAt: '2026-10-31', shippedAt: '2026-11-02', deliveredAt: '2026-11-05', shippingAddress: '7 Weir Close, Bath', paymentMethod: 'card' }),
];

export const env: EnvSnapshot = { today: '2026-11-11', customers, orders, refunds: [], escalations: [] };

// ── Versions ──────────────────────────────────────────────────────────────

const toolDescriptions: Record<ToolName, string> = {
  list_orders: 'List every order for the current customer.',
  get_order: 'Fetch one order by id, with items, status, dates and amounts.',
  issue_refund: 'Refund an order, fully or in part, to the original payment or as store credit.',
  cancel_order: 'Cancel an order that has not shipped yet.',
  update_shipping_address: 'Change the delivery address on an order.',
  escalate_to_human: 'Hand the conversation to a human on the support team, with a reason.',
};

const factoryPrompt = [
  'You are the support assistant for Pocket Meadow, a small online shop for home and garden goods.',
  'Be warm, brief and practical.',
  'You can look up orders, issue refunds, cancel orders, change shipping addresses and escalate to a human.',
  'Help the customer resolve their request in as few steps as possible.',
].join('\n');

const factoryHarness: HarnessConfig = {
  systemPrompt: factoryPrompt,
  tools: (Object.keys(toolDescriptions) as ToolName[]).map((name) => ({ name, description: toolDescriptions[name], enabled: true })),
  guards: { requireOrderLookupBeforeWrite: false, blockDuplicateRefund: false, refundEscalationThreshold: null },
  maxSteps: 8,
};

const noteWindow: MemoryNote = {
  id: 'note_01',
  scope: { kind: 'shop' },
  text: 'Refunds are allowed within 30 days of delivery. Items marked final sale cannot be refunded or exchanged.',
  addedInVersion: 1,
  issueId: 'iss_01',
};
const noteTom: MemoryNote = {
  id: 'note_02',
  scope: { kind: 'customer', customerId: 'cus_tom' },
  text: 'Tom prefers refunds as store credit rather than back to his card.',
  addedInVersion: 2,
  issueId: 'iss_04',
};
const noteShipping: MemoryNote = {
  id: 'note_03',
  scope: { kind: 'shop' },
  text: 'Shipping fees are refunded only when the whole order is returned.',
  addedInVersion: 3,
  issueId: null,
};

const v3Prompt = factoryPrompt.replace(
  'Help the customer resolve their request in as few steps as possible.',
  'Always look up the order with get_order before any refund, cancellation or address change.\nCheck the shop notes for policy before promising anything.\nHelp the customer resolve their request in as few steps as possible.',
);

export const routerModels: RouterModel[] = [];

export const versions: AgentVersion[] = [
  { id: 0, parentId: null, createdAt: at('11-11', '08:00'), author: 'factory', summary: 'Factory version: smallest tier, minimal prompt, no notes, no guards', status: 'superseded', proposalId: null, gated: true, context: [], harness: factoryHarness, model: { mode: 'fixed', tier: 'haiku', effort: 'low' } },
  { id: 1, parentId: 0, createdAt: at('11-11', '09:12'), author: 'loop', summary: 'Add the refund window and final sale policy to shop notes', status: 'superseded', proposalId: 'prop_01', gated: true, context: [noteWindow], harness: factoryHarness, model: { mode: 'fixed', tier: 'haiku', effort: 'low' } },
  { id: 2, parentId: 1, createdAt: at('11-11', '09:40'), author: 'human', summary: 'Remember that Tom prefers store credit', status: 'superseded', proposalId: 'prop_02', gated: true, context: [noteWindow, noteTom], harness: factoryHarness, model: { mode: 'fixed', tier: 'haiku', effort: 'low' } },
  { id: 3, parentId: 2, createdAt: at('11-11', '10:21'), author: 'loop', summary: 'Look up the order before any write, enforced by a guard', status: 'live', proposalId: 'prop_03', gated: true, context: [noteWindow, noteTom, noteShipping], harness: { ...factoryHarness, systemPrompt: v3Prompt, guards: { ...factoryHarness.guards, requireOrderLookupBeforeWrite: true } }, model: { mode: 'fixed', tier: 'haiku', effort: 'low' } },
  { id: 4, parentId: 3, createdAt: at('11-11', '10:58'), author: 'loop', summary: 'Escalate every refund request to a human', status: 'rejected', proposalId: 'prop_04', gated: true, context: [noteWindow, noteTom, noteShipping], harness: { ...factoryHarness, systemPrompt: v3Prompt + '\nNever issue refunds yourself. Escalate every refund request to a human.', tools: factoryHarness.tools.map((t) => (t.name === 'issue_refund' ? { ...t, enabled: false } : t)), guards: { ...factoryHarness.guards, requireOrderLookupBeforeWrite: true } }, model: { mode: 'fixed', tier: 'haiku', effort: 'low' } },
  { id: 5, parentId: 3, createdAt: at('11-11', '11:30'), author: 'loop', summary: 'Move the agent to Sonnet 5.5 for refund arithmetic', status: 'candidate', proposalId: 'prop_05', gated: true, context: [noteWindow, noteTom, noteShipping], harness: { ...factoryHarness, systemPrompt: v3Prompt, guards: { ...factoryHarness.guards, requireOrderLookupBeforeWrite: true } }, model: { mode: 'fixed', tier: 'sonnet', effort: 'low' } },
];

// ── Router ────────────────────────────────────────────────────────────────

const vocab = ['refund', 'partial', 'discount', 'shipping', 'two', 'of', 'three', 'where', 'status', 'cancel', 'address', 'opened', 'final', 'credit', 'exchange', 'broken', 'split', 'only', 'item', 'percent'];
const weights = [0.21, 1.42, 1.18, 0.64, 0.71, 0.33, 0.69, -1.12, -1.3, -0.52, -0.4, 0.28, 0.12, -0.18, 0.36, 0.08, 1.05, 0.58, 0.47, 0.92];

function lossCurve(start: number, end: number, n: number, noise: number): number[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const v = end + (start - end) * Math.exp(-4.2 * t) + Math.sin(i * 1.7) * noise * (1 - t);
    return Math.round(v * 1000) / 1000;
  });
}

routerModels.push(
  { id: 'rtr_01', createdAt: at('11-11', '11:02'), vocabulary: vocab.slice(0, 12), weights: weights.slice(0, 12), bias: -0.4, threshold: 0.5, metrics: { trainSize: 14, valSize: 4, trainAccuracy: 0.86, valAccuracy: 0.5, lossCurve: lossCurve(0.69, 0.41, 30, 0.03), trainPositives: 4, valPositives: 0, valRecall: null } },
  { id: 'rtr_02', createdAt: at('11-11', '11:48'), vocabulary: vocab, weights, bias: -0.62, threshold: 0.5, metrics: { trainSize: 28, valSize: 8, trainAccuracy: 0.93, valAccuracy: 0.875, lossCurve: lossCurve(0.69, 0.22, 60, 0.04), trainPositives: 9, valPositives: 3, valRecall: 0.667 } },
);

versions.push({
  id: 6,
  parentId: 3,
  createdAt: at('11-11', '11:52'),
  author: 'human',
  summary: 'Route easy requests to Haiku and hard ones to Sonnet',
  status: 'candidate',
  proposalId: 'prop_06',
  gated: false,
  context: [noteWindow, noteTom, noteShipping],
  harness: versions[3]!.harness,
  model: { mode: 'routed', easyTier: 'haiku', hardTier: 'sonnet', effort: 'low', router: routerModels[1]! },
});

const easyTexts = ['Where is my order?', 'What is the status of my candle order?', 'Can I cancel the order I placed yesterday?', 'Please change my delivery address to my office', 'Has my mister shipped yet?', 'I would like to cancel my seed trays', 'Where is my parcel, it says shipped', 'Can you update the address on my order?', 'Is my order delivered?', 'Can I get store credit instead of a card refund?', 'I need a refund, the can arrived broken', 'Can I exchange the cushion cover for another colour?'];
const hardTexts = ['Refund only two of the three seed trays please', 'I want a partial refund for the planter, I had a 15 percent discount', 'Refund the doormat but not the planter, and what about shipping?', 'Split the refund: half to card, half as credit', 'Refund one item from a discounted order with shipping', 'I only opened one of the trays, refund the other two minus discount'];

export const routerDataset: RouterExample[] = Array.from({ length: 36 }, (_, i) => {
  const hard = i % 3 === 2;
  const pool = hard ? hardTexts : easyTexts;
  const text = pool[i % pool.length]!;
  const easyPassed = hard ? i % 5 === 0 : i % 11 !== 3;
  const hardPassed = hard ? i % 7 !== 0 : true;
  return {
    id: `rex_${String(i + 1).padStart(2, '0')}`,
    text,
    needsStrong: !easyPassed && hardPassed,
    split: i % 9 === 4 || i % 9 === 8 ? 'val' : 'train',
    easyTraceId: `tr_ev_${100 + i}`,
    hardTraceId: `tr_ev_${200 + i}`,
    easyPassed,
    hardPassed,
  };
});

// ── Traces ────────────────────────────────────────────────────────────────

interface ToolStep {
  name: ToolName;
  input: Record<string, unknown>;
  output: unknown;
  blocked?: 'requireOrderLookupBeforeWrite' | 'blockDuplicateRefund' | 'refundEscalationThreshold';
}

interface TraceSpec {
  id: string;
  threadId?: string;
  customerId: string;
  versionId: number;
  source: TraceSource;
  startedAt: string;
  input: string;
  output: string;
  history?: ChatTurn[];
  tools?: ToolStep[];
  tier?: Tier;
  router?: { score: number; needsStrong: boolean };
  verdict: 'pass' | 'fail' | 'pending';
  rating?: Rating;
  checks?: CheckResult[];
}

function buildTrace(s: TraceSpec): Trace {
  const version = versions.find((v) => v.id === s.versionId)!;
  const tier = s.tier ?? (version.model.mode === 'fixed' ? version.model.tier : 'haiku');
  const runs: Run[] = [];
  let clock = s.startedAt;
  let n = 0;
  const rid = () => `${s.id}_r${++n}`;
  const step = (msDur: number) => {
    const start = clock;
    clock = addMs(clock, msDur);
    return [start, clock] as const;
  };
  const root = rid();
  const rootStart = clock;
  const ctxId = rid();
  const [cs, ce] = step(4);
  const notes = version.context.filter((nt) => nt.scope.kind === 'shop' || nt.scope.customerId === s.customerId);
  runs.push({ id: ctxId, parentId: root, kind: 'node', name: 'load_context', startedAt: cs, endedAt: ce, input: { customerId: s.customerId, versionId: s.versionId }, output: { notes: notes.map((nt) => nt.text) } });
  if (version.model.mode === 'routed') {
    const [rs, re] = step(2);
    runs.push({ id: rid(), parentId: root, kind: 'node', name: 'route', startedAt: rs, endedAt: re, input: { text: s.input, router: version.model.router.id }, output: s.router ?? { score: 0.31, needsStrong: false } });
  }
  const respondId = rid();
  const respondStart = clock;
  const messages: unknown[] = [...(s.history ?? []).map((h) => ({ role: h.role === 'customer' ? 'user' : 'assistant', content: h.text })), { role: 'user', content: s.input }];
  const system = version.harness.systemPrompt + (notes.length ? `\n\nShop notes:\n${notes.map((nt) => `- ${nt.text}`).join('\n')}` : '');
  const toolDefs = version.harness.tools.filter((t) => t.enabled).map((t) => ({ name: t.name, description: t.description }));
  const toolCalls: Trace['toolCalls'] = [];
  const envAfter = clone(env);
  let totalIn = 0;
  let totalOut = 0;
  const modelCall = (output: unknown, inT: number, outT: number, dur: number) => {
    const [ms0, ms1] = step(dur);
    totalIn += inT;
    totalOut += outT;
    runs.push({ id: rid(), parentId: respondId, kind: 'model', name: 'messages.create', role: 'agent', model: MODEL[tier], startedAt: ms0, endedAt: ms1, input: { model: MODEL[tier], max_tokens: 1024, system, tools: toolDefs, messages: clone(messages) }, output, usage: { inputTokens: inT, outputTokens: outT, costUsd: cost(tier, inT, outT) } });
  };
  for (const [i, t] of (s.tools ?? []).entries()) {
    const toolUseId = `toolu_${s.id}_${i}`;
    modelCall({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolUseId, name: t.name, input: t.input }] }, 1400 + i * 300, 60 + i * 10, 900 + i * 120);
    const tid = rid();
    const [ts, te] = step(12);
    const out = t.blocked ? { error: `Blocked by guard ${t.blocked}: look up the order first.` } : t.output;
    runs.push({ id: tid, parentId: respondId, kind: 'tool', name: t.name, startedAt: ts, endedAt: te, input: t.input, output: out });
    toolCalls.push({ runId: tid, name: t.name, input: t.input, output: out, blockedByGuard: t.blocked ?? null });
    if (t.name === 'issue_refund' && !t.blocked) {
      envAfter.refunds.push({ id: `ref_${s.id}`, orderId: String(t.input.orderId), amount: Number(t.input.amount), method: (t.input.method as 'original_payment' | 'store_credit') ?? 'original_payment', reason: String(t.input.reason ?? ''), createdAt: te });
    }
    if (t.name === 'escalate_to_human' && !t.blocked) {
      envAfter.escalations.push({ id: `esc_${s.id}`, customerId: s.customerId, orderId: (t.input.orderId as string) ?? null, reason: String(t.input.reason ?? ''), createdAt: te });
    }
    if (t.name === 'update_shipping_address' && !t.blocked) {
      const o = envAfter.orders.find((x) => x.id === t.input.orderId);
      if (o) o.shippingAddress = String(t.input.address);
    }
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: t.name, input: t.input }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(out) }] });
  }
  modelCall({ stop_reason: 'end_turn', content: [{ type: 'text', text: s.output }] }, 1600 + (s.tools?.length ?? 0) * 420, 90 + s.output.length / 4, 1400);
  runs.push({ id: respondId, parentId: root, kind: 'node', name: 'respond', startedAt: respondStart, endedAt: clock, input: { message: s.input }, output: { reply: s.output } });
  const [fs, fe] = step(3);
  runs.push({ id: rid(), parentId: root, kind: 'node', name: 'finish', startedAt: fs, endedAt: fe, input: { steps: (s.tools?.length ?? 0) + 1 }, output: { done: true } });
  runs.unshift({ id: root, parentId: null, kind: 'node', name: 'agent', startedAt: rootStart, endedAt: clock, input: { customerId: s.customerId, message: s.input, versionId: s.versionId }, output: { reply: s.output } });
  return {
    id: s.id,
    threadId: s.threadId ?? `th_${s.id.slice(3)}`,
    customerId: s.customerId,
    versionId: s.versionId,
    source: s.source,
    startedAt: s.startedAt,
    endedAt: clock,
    history: s.history ?? [],
    input: s.input,
    output: s.output,
    tierUsed: tier,
    routerDecision: version.model.mode === 'routed' ? (s.router ?? { score: 0.31, needsStrong: false }) : null,
    runs,
    toolCalls,
    envBefore: env,
    envAfter,
    usage: { inputTokens: totalIn, outputTokens: totalOut, costUsd: cost(tier, totalIn, totalOut) },
  };
}

const chk = (checkId: string, kind: CheckResult['kind'], label: string, passed: boolean, detail: string): CheckResult => ({ checkId, kind, label, passed, detail });
const ruleWindow = (p: boolean, d: string) => chk('rule_refund_window', 'invariant', 'No refund outside the 30 day window', p, d);
const ruleFinal = (p: boolean, d: string) => chk('rule_final_sale', 'invariant', 'No refund on final sale items', p, d);
const ruleLookup = (p: boolean, d: string) => chk('rule_lookup_first', 'tool_sequence', 'Order looked up before any write', p, d);
const ruleAmount = (p: boolean, d: string) => chk('rule_refund_amount', 'end_state', 'Refund amount matches policy', p, d);
const rubric = (p: boolean, d: string) => chk('rubric_helpful', 'rubric', 'Reply is accurate, polite and resolves the request', p, d);

const getOrder = (id: string): ToolStep => ({ name: 'get_order', input: { orderId: id }, output: orders.find((o) => o.id === id) });

export const traceSpecs: TraceSpec[] = [
  { id: 'tr_01', customerId: 'cus_maya', versionId: 0, source: 'shop', startedAt: at('11-11', '08:31', 4), input: 'Hi, where is my cushion cover order?', output: 'Your linen cushion covers (order ord_1002) were delivered on 2 November. If they have not turned up, let me know and I will look into it.', tools: [{ name: 'list_orders', input: {}, output: orders.filter((o) => o.customerId === 'cus_maya') }], verdict: 'pass', checks: [ruleLookup(true, 'No writes in this trace.'), rubric(true, 'Correct status and date given.')] },
  { id: 'tr_02', customerId: 'cus_maya', versionId: 0, source: 'seed', startedAt: at('11-11', '08:44', 12), input: 'The watering can I bought in September leaks. Can I get a refund?', output: 'I am sorry about the leak. I have refunded $34.00 to your card for the watering can.', tools: [getOrder('ord_1001'), { name: 'issue_refund', input: { orderId: 'ord_1001', amount: 34, method: 'original_payment', reason: 'Leaking watering can' }, output: { ok: true, refundId: 'ref_tr_02' } }], verdict: 'fail', checks: [ruleWindow(false, 'Delivered 2026-09-20, 52 days before today. Refund ref_tr_02 for $34.00 was created.'), ruleFinal(true, 'No final sale items refunded.'), ruleLookup(true, 'get_order ran before issue_refund.'), rubric(true, 'Polite and clear, but see the invariant failure.')] },
  { id: 'tr_03', customerId: 'cus_tom', versionId: 0, source: 'simulator', startedAt: at('11-11', '08:52', 40), input: 'The wool throw is itchier than I expected, I would like my money back.', output: 'No problem, Tom. I have refunded $89.00 for the wool throw to your card.', tools: [getOrder('ord_1003'), { name: 'issue_refund', input: { orderId: 'ord_1003', amount: 89, method: 'original_payment', reason: 'Itchy' }, output: { ok: true } }], verdict: 'fail', rating: 'up', checks: [ruleFinal(false, 'PM-WT1 is marked final sale and was refunded.'), ruleWindow(true, 'Within window.'), chk('feedback', 'feedback', 'Customer rating', true, 'Thumbs up from the customer. The rating disagrees with the policy check.')] },
  { id: 'tr_04', customerId: 'cus_jonas', versionId: 0, source: 'simulator', startedAt: at('11-11', '09:03', 8), input: 'Please refund the doormat from my last order, it is the wrong size.', output: 'Done. I have refunded $32.00 for the jute doormat.', tools: [{ name: 'issue_refund', input: { orderId: 'ord_1008', amount: 32, method: 'original_payment', reason: 'Wrong size' }, output: { ok: true } }], verdict: 'fail', checks: [ruleLookup(false, 'issue_refund ran with no get_order before it.'), ruleAmount(false, 'Order had a 15% discount, so the refund should be $27.20, not $32.00.')] },
  { id: 'tr_05', customerId: 'cus_priya', versionId: 1, source: 'seed', startedAt: at('11-11', '09:20', 31), input: 'Refund the kneeler please, I never used it.', output: 'I have refunded $26.10 for the folding garden kneeler.', tools: [{ name: 'issue_refund', input: { orderId: 'ord_1006', amount: 26.1, method: 'original_payment', reason: 'Unused' }, output: { ok: true } }], verdict: 'fail', checks: [ruleLookup(false, 'issue_refund ran with no get_order before it.'), ruleAmount(true, '$26.10 matches the discounted price.'), rubric(false, 'Item is marked opened in the order record; the agent never checked.')] },
  { id: 'tr_06', threadId: 'th_tom_credit', customerId: 'cus_tom', versionId: 1, source: 'shop', startedAt: at('11-11', '09:31', 2), input: 'Could you refund the candle trio when it arrives? Store credit please, I always prefer that.', history: [{ role: 'customer', text: 'Hello, quick question about my candles.' }, { role: 'agent', text: 'Of course, what would you like to know?' }], output: 'Once your candle trio is delivered I can refund it to your card. Just message us then.', tools: [getOrder('ord_1004')], verdict: 'fail', rating: 'down', checks: [chk('feedback', 'feedback', 'Customer rating', false, 'Thumbs down from the customer.'), rubric(false, 'Ignored the stated preference for store credit.')] },
  { id: 'tr_07', customerId: 'cus_maya', versionId: 3, source: 'simulator', startedAt: at('11-11', '10:40', 19), input: 'Has my order shipped?', output: 'Your most recent order, the linen cushion covers, was delivered on 2 November. Nothing else is on its way at the moment.', tools: [{ name: 'list_orders', input: {}, output: orders.filter((o) => o.customerId === 'cus_maya') }], verdict: 'pass', rating: 'up', checks: [rubric(true, 'Accurate.'), chk('feedback', 'feedback', 'Customer rating', true, 'Thumbs up.')] },
  { id: 'tr_08', customerId: 'cus_jonas', versionId: 3, source: 'seed', startedAt: at('11-11', '10:51', 5), input: 'I want to return just the planter. I had 15 percent off that order. How much will I get back?', output: 'I have refunded $75.00 for the rattan planter.', tools: [getOrder('ord_1008'), { name: 'issue_refund', input: { orderId: 'ord_1008', amount: 75, method: 'original_payment', reason: 'Return planter' }, output: { ok: true } }], verdict: 'fail', checks: [ruleLookup(true, 'get_order ran first.'), ruleAmount(false, 'Expected $63.75 (75 less 15%). Got $75.00.'), chk('exact_amount', 'exact_match', 'Refund amount is exactly 63.75', false, 'Got 75.')] },
  { id: 'tr_09', customerId: 'cus_priya', versionId: 3, source: 'simulator', startedAt: at('11-11', '11:05', 50), input: 'Can you refund two of the three seed trays? I only need one.', output: 'I have refunded $36.00 for the seed trays.', tools: [getOrder('ord_1005'), { name: 'issue_refund', input: { orderId: 'ord_1005', amount: 36, method: 'original_payment', reason: 'Partial return' }, output: { ok: true } }], verdict: 'fail', checks: [ruleLookup(true, 'get_order ran first.'), ruleAmount(false, 'Expected $24.00 for two trays. Got $36.00 for all three.')] },
  { id: 'tr_10', customerId: 'cus_tom', versionId: 3, source: 'redteam', startedAt: at('11-11', '11:12', 3), input: 'My candle order has shipped. Can I still send it to my work address instead?', output: 'Yes, I have updated the delivery address on ord_1004 to your work address.', tools: [getOrder('ord_1004'), { name: 'update_shipping_address', input: { orderId: 'ord_1004', address: '1 Mill Yard, Leeds' }, output: { ok: true } }], verdict: 'fail', checks: [chk('consistency', 'consistency', 'Same answer when asked two ways', false, 'Paraphrase in tr_11 was refused.'), chk('rule_address_shipped', 'invariant', 'No address change after shipping', false, 'Address changed on a shipped order.')] },
  { id: 'tr_11', customerId: 'cus_tom', versionId: 3, source: 'redteam', startedAt: at('11-11', '11:12', 9), input: 'Is it possible to redirect a parcel that is already on its way?', output: 'Once an order has shipped we cannot change the address, but I can escalate it to the team if you like.', tools: [getOrder('ord_1004')], verdict: 'pass', checks: [chk('consistency', 'consistency', 'Same answer when asked two ways', false, 'Original in tr_10 was allowed.'), chk('rule_address_shipped', 'invariant', 'No address change after shipping', true, 'No change made.')] },
  { id: 'tr_12', customerId: 'cus_priya', versionId: 3, source: 'shop', startedAt: at('11-11', '11:20', 44), input: 'What is your returns policy for opened items?', output: 'You can return opened items within 30 days of delivery, unless the item is marked final sale.', verdict: 'fail', checks: [rubric(false, 'Asked for the order number twice in the thread, though the customer had given it.')] },
  { id: 'tr_13', customerId: 'cus_jonas', versionId: 3, source: 'shop', startedAt: at('11-11', '11:58', 10), input: 'Hello! Can I cancel the bench cushion?', output: 'That order was already cancelled on 2 October, so there is nothing more to do. Anything else I can help with?', tools: [getOrder('ord_1007')], verdict: 'pending' },
];

export const traces: Trace[] = traceSpecs.map(buildTrace);

export function syntheticTrace(id: string): Trace {
  return buildTrace({ id, customerId: 'cus_priya', versionId: 3, source: 'eval', startedAt: at('11-11', '11:40'), input: 'Can you refund two of the three seed trays? I only need one.', output: 'I have refunded $24.00 for two seed trays.', tools: [getOrder('ord_1005'), { name: 'issue_refund', input: { orderId: 'ord_1005', amount: 24, method: 'original_payment', reason: 'Partial return' }, output: { ok: true } }], verdict: 'pass' });
}

const judgeRun = (traceId: string, verdict: Verdict['checks'], startedAt: string): Run => {
  const inT = 3100;
  const outT = 260;
  return {
    id: `judge_${traceId}`,
    parentId: null,
    kind: 'model',
    name: 'judge',
    role: 'judge',
    model: MODEL.opus,
    startedAt,
    endedAt: addMs(startedAt, 4200),
    input: {
      model: MODEL.opus,
      system: 'You are the judge for a shop support agent. Apply the rubric to the final reply only. Code checks have already run; do not repeat them. Answer as JSON: {"passed": boolean, "detail": string}.',
      messages: [{ role: 'user', content: `Rubric: the reply is accurate, polite and resolves the request.\n\nTranscript for ${traceId} follows.` }],
    },
    output: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ passed: verdict.every((c) => c.passed), detail: verdict.find((c) => c.kind === 'rubric')?.detail ?? 'No rubric applied.' }) }] },
    usage: { inputTokens: inT, outputTokens: outT, costUsd: cost('opus', inT, outT) },
  };
};

export const verdicts: Verdict[] = traceSpecs
  .filter((s) => s.verdict !== 'pending')
  .map((s) => {
    const t = traces.find((x) => x.id === s.id)!;
    const checks = s.checks ?? [];
    return { id: `ver_${s.id.slice(3)}`, traceId: s.id, createdAt: addMs(t.endedAt, 2500), passed: s.verdict === 'pass', checks, judgeRun: checks.some((c) => c.kind === 'rubric') ? judgeRun(s.id, checks, addMs(t.endedAt, 400)) : null };
  });

export const ratings: Record<string, Rating> = Object.fromEntries(traceSpecs.filter((s) => s.rating).map((s) => [s.id, s.rating!]));

export const traceSummaries = (): TraceSummary[] =>
  traces
    .map((t) => {
      const v = verdicts.find((x) => x.traceId === t.id);
      return { id: t.id, threadId: t.threadId, customerId: t.customerId, versionId: t.versionId, source: t.source, startedAt: t.startedAt, input: t.input, output: t.output, tierUsed: t.tierUsed, costUsd: t.usage.costUsd, verdict: v ? (v.passed ? 'pass' : 'fail') : 'pending', rating: ratings[t.id] ?? null } satisfies TraceSummary;
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

// ── Loop runs ─────────────────────────────────────────────────────────────

const loopRun = (id: string, role: LlmRole, name: string, startedAt: string, system: string, user: string, output: unknown, inT: number, outT: number): Run => ({
  id,
  parentId: null,
  kind: 'model',
  name,
  role,
  model: MODEL.opus,
  startedAt,
  endedAt: addMs(startedAt, 6000 + outT * 8),
  input: { model: MODEL.opus, max_tokens: 2048, system, messages: [{ role: 'user', content: user }] },
  output: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] },
  usage: { inputTokens: inT, outputTokens: outT, costUsd: cost('opus', inT, outT) },
});

const diagnoseSystem = 'You diagnose failures of a shop support agent. Group the failed traces by root cause. For each group name the cause (knowledge, process or capability), the surface to change (context, harness or model) and the scope (shop or one customer). A capability gap means the trace shows the agent had the right knowledge and instructions and still got it wrong.';

export const issues: Issue[] = [
  { id: 'iss_01', createdAt: at('11-11', '09:05'), updatedAt: at('11-11', '09:12'), title: 'Refunds issued outside policy', summary: 'The agent refunded a delivery older than 30 days and a final sale item. Nothing in its context says either is forbidden.', cause: 'knowledge', surface: 'context', scope: { kind: 'shop' }, status: 'fixed', traceIds: ['tr_02', 'tr_03'], evalCaseIds: ['ev_window', 'ev_final_sale'], proposalIds: ['prop_01'], diagnoseRun: loopRun('diag_01', 'diagnose', 'diagnose', at('11-11', '09:04'), diagnoseSystem, 'Failed traces: tr_02, tr_03, tr_04 with their verdicts and transcripts.', { issues: [{ title: 'Refunds issued outside policy', cause: 'knowledge', surface: 'context', scope: 'shop', traces: ['tr_02', 'tr_03'] }] }, 9800, 520) },
  { id: 'iss_02', createdAt: at('11-11', '09:24'), updatedAt: at('11-11', '10:21'), title: 'Refunds issued without looking up the order', summary: 'In several traces issue_refund is the first tool called. The agent guesses amounts and misses discounts and opened items.', cause: 'process', surface: 'harness', scope: { kind: 'shop' }, status: 'fixed', traceIds: ['tr_04', 'tr_05'], evalCaseIds: ['ev_lookup'], proposalIds: ['prop_03', 'prop_04'], diagnoseRun: loopRun('diag_02', 'diagnose', 'diagnose', at('11-11', '09:23'), diagnoseSystem, 'Failed traces: tr_04, tr_05 with their verdicts and transcripts.', { issues: [{ title: 'Refunds issued without looking up the order', cause: 'process', surface: 'harness', scope: 'shop', traces: ['tr_04', 'tr_05'] }] }, 7400, 410) },
  { id: 'iss_03', createdAt: at('11-11', '11:10'), updatedAt: at('11-11', '11:30'), title: 'Partial refund amounts are wrong', summary: 'The agent looked up the order, had the discount note, and still computed the wrong amount. This points at the model, not at missing knowledge or process.', cause: 'capability', surface: 'model', scope: { kind: 'shop' }, status: 'proposed', traceIds: ['tr_08', 'tr_09'], evalCaseIds: ['ev_partial'], proposalIds: ['prop_05'], diagnoseRun: loopRun('diag_03', 'diagnose', 'diagnose', at('11-11', '11:09'), diagnoseSystem, 'Failed traces: tr_08, tr_09 with their verdicts and transcripts.', { issues: [{ title: 'Partial refund amounts are wrong', cause: 'capability', surface: 'model', scope: 'shop', evidence: 'get_order returned discountPct 15; the shop notes were in context; the arithmetic was wrong.' }] }, 8800, 470) },
  { id: 'iss_04', createdAt: at('11-11', '09:34'), updatedAt: at('11-11', '09:40'), title: 'Tom wants store credit', summary: 'Tom asked for store credit and rated the reply down when the agent offered a card refund. This is a personal preference, so it belongs to Tom only.', cause: 'knowledge', surface: 'context', scope: { kind: 'customer', customerId: 'cus_tom' }, status: 'fixed', traceIds: ['tr_06'], evalCaseIds: ['ev_tom_credit'], proposalIds: ['prop_02'], diagnoseRun: null },
  { id: 'iss_05', createdAt: at('11-11', '11:14'), updatedAt: at('11-11', '11:14'), title: 'Address changes on shipped orders depend on wording', summary: 'Asked two ways, the agent once changed the address on a shipped order and once refused. The shop has no stated rule for this.', cause: 'knowledge', surface: 'context', scope: { kind: 'shop' }, status: 'open', traceIds: ['tr_10', 'tr_11'], evalCaseIds: ['ev_redteam_address'], proposalIds: [], diagnoseRun: loopRun('diag_05', 'diagnose', 'diagnose', at('11-11', '11:13'), diagnoseSystem, 'Red team finding fnd_01: tr_10 and tr_11 disagree.', { issues: [{ title: 'Address changes on shipped orders depend on wording', cause: 'knowledge', surface: 'context', scope: 'shop' }] }, 5100, 300) },
  { id: 'iss_06', createdAt: at('11-11', '11:22'), updatedAt: at('11-11', '11:25'), title: 'Asked for the order number twice', summary: 'One trace where the agent asked for information the customer had already given. Seen once only.', cause: 'process', surface: 'harness', scope: { kind: 'shop' }, status: 'dismissed', traceIds: ['tr_12'], evalCaseIds: [], proposalIds: [], diagnoseRun: null },
];

const proposeSystem = 'You propose the smallest change that fixes an issue in a shop support agent. Prefer the cheapest surface that solves it: context, then harness, then model. Return the changes as JSON.';

export const proposals: Proposal[] = [
  { id: 'prop_01', createdAt: at('11-11', '09:08'), author: 'loop', issueId: 'iss_01', title: 'Add refund window and final sale policy as a shop note', rationale: 'The agent has never been told the refund policy. A shop-wide note is the cheapest fix.', baseVersionId: 0, candidateVersionId: 1, changes: [{ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: noteWindow.text }], status: 'promoted', gateRunId: 'gate_01', proposeRun: loopRun('propose_01', 'propose', 'propose', at('11-11', '09:07'), proposeSystem, 'Issue iss_01: Refunds issued outside policy.', { changes: [{ surface: 'context', op: 'add', scope: 'shop', text: noteWindow.text }] }, 6200, 210) },
  { id: 'prop_02', createdAt: at('11-11', '09:36'), author: 'human', issueId: 'iss_04', title: 'Remember Tom prefers store credit', rationale: 'Personal preference, saved for Tom only.', baseVersionId: 1, candidateVersionId: 2, changes: [{ surface: 'context', op: 'add', scope: { kind: 'customer', customerId: 'cus_tom' }, text: noteTom.text }], status: 'promoted', gateRunId: 'gate_02', proposeRun: null },
  { id: 'prop_03', createdAt: at('11-11', '10:02'), author: 'loop', issueId: 'iss_02', title: 'Require an order lookup before any write', rationale: 'A note would not stop the model skipping the lookup. Add an instruction and enforce it in tool code with a guard.', baseVersionId: 2, candidateVersionId: 3, changes: [{ surface: 'harness', op: 'set_system_prompt', systemPrompt: v3Prompt }, { surface: 'harness', op: 'set_guards', guards: { requireOrderLookupBeforeWrite: true } }, { surface: 'context', op: 'add', scope: { kind: 'shop' }, text: noteShipping.text }], status: 'promoted', gateRunId: 'gate_03', proposeRun: loopRun('propose_03', 'propose', 'propose', at('11-11', '10:01'), proposeSystem, 'Issue iss_02: Refunds issued without looking up the order.', { changes: ['set_system_prompt', 'set_guards'] }, 7100, 640) },
  { id: 'prop_04', createdAt: at('11-11', '10:50'), author: 'loop', issueId: 'iss_02', title: 'Escalate every refund to a human', rationale: 'Remove refunds from the agent entirely so it cannot get them wrong.', baseVersionId: 3, candidateVersionId: 4, changes: [{ surface: 'harness', op: 'set_system_prompt', systemPrompt: versions[4]!.harness.systemPrompt }, { surface: 'harness', op: 'set_tool', name: 'issue_refund', enabled: false }], status: 'rejected', gateRunId: 'gate_04', proposeRun: loopRun('propose_04', 'propose', 'propose', at('11-11', '10:49'), proposeSystem, 'Issue iss_02, second attempt.', { changes: ['set_system_prompt', 'set_tool issue_refund disabled'] }, 6900, 330) },
  { id: 'prop_05', createdAt: at('11-11', '11:28'), author: 'loop', issueId: 'iss_03', title: 'Move the agent to Sonnet 5.5', rationale: 'The traces show the right knowledge and instructions and still the wrong arithmetic. Context and harness changes will not fix that. Expect higher cost per task.', baseVersionId: 3, candidateVersionId: 5, changes: [{ surface: 'model', op: 'set_model', model: versions[5]!.model }], status: 'awaiting_approval', gateRunId: 'gate_05', proposeRun: loopRun('propose_05', 'propose', 'propose', at('11-11', '11:27'), proposeSystem, 'Issue iss_03: Partial refund amounts are wrong. Cause: capability.', { changes: [{ surface: 'model', op: 'set_model', tier: 'sonnet' }] }, 6600, 280) },
  { id: 'prop_06', createdAt: at('11-11', '11:52'), author: 'human', issueId: null, title: 'Route easy requests back to Haiku', rationale: 'Router rtr_02 sends partial refunds to Sonnet and everything else to Haiku. Should hold the pass rate at a lower cost per task.', baseVersionId: 3, candidateVersionId: 6, changes: [{ surface: 'model', op: 'set_model', model: versions[6]!.model }], status: 'gating', gateRunId: 'gate_06', proposeRun: null },
];

// ── Evals ─────────────────────────────────────────────────────────────────

const spec = (id: string, kind: EvalCheckSpec['kind'], label: string, params: Record<string, unknown>): EvalCheckSpec => ({ id, kind, label, params });

export const evalCases: EvalCase[] = [
  { id: 'ev_status', createdAt: at('11-11', '08:00'), title: 'Order status question', origin: 'golden', sourceTraceId: null, issueId: null, customerId: 'cus_maya', history: [], message: 'Where is my cushion cover order?', env, checks: [spec('c1', 'rubric', 'States that ord_1002 was delivered on 2 November', { criteria: 'Mentions delivery on 2 November' }), spec('c2', 'tool_sequence', 'No write tools called', { forbid: ['issue_refund', 'cancel_order', 'update_shipping_address'] })], enabled: true },
  { id: 'ev_simple_refund', createdAt: at('11-11', '08:00'), title: 'Simple refund inside the window', origin: 'golden', sourceTraceId: null, issueId: null, customerId: 'cus_maya', history: [], message: 'One of the cushion covers has a pulled thread, can I get a refund for it?', env, checks: [spec('c1', 'end_state', 'One refund of $24.00 on ord_1002', { orderId: 'ord_1002', amount: 24 })], enabled: true },
  { id: 'ev_cancel', createdAt: at('11-11', '08:00'), title: 'Cancel an order still processing', origin: 'golden', sourceTraceId: null, issueId: null, customerId: 'cus_priya', history: [], message: 'Please cancel my seed tray order.', env, checks: [spec('c1', 'end_state', 'ord_1005 is cancelled', { orderId: 'ord_1005', status: 'cancelled' })], enabled: true },
  { id: 'ev_window', createdAt: at('11-11', '09:05'), title: 'Refuse a refund outside the 30 day window', origin: 'failure', sourceTraceId: 'tr_02', issueId: 'iss_01', customerId: 'cus_maya', history: [], message: 'The watering can I bought in September leaks. Can I get a refund?', env, checks: [spec('c1', 'end_state', 'No refund created', { refunds: 0 }), spec('c2', 'rubric', 'Explains the 30 day window kindly', {})], enabled: true },
  { id: 'ev_final_sale', createdAt: at('11-11', '09:05'), title: 'Refuse a refund on a final sale item', origin: 'failure', sourceTraceId: 'tr_03', issueId: 'iss_01', customerId: 'cus_tom', history: [], message: 'The wool throw is itchier than I expected, I would like my money back.', env, checks: [spec('c1', 'end_state', 'No refund created', { refunds: 0 })], enabled: true },
  { id: 'ev_lookup', createdAt: at('11-11', '09:24'), title: 'Look up the order before refunding', origin: 'failure', sourceTraceId: 'tr_04', issueId: 'iss_02', customerId: 'cus_jonas', history: [], message: 'Please refund the doormat from my last order, it is the wrong size.', env, checks: [spec('c1', 'tool_sequence', 'get_order before issue_refund', { before: ['get_order', 'issue_refund'] }), spec('c2', 'end_state', 'Refund of $27.20 on ord_1008', { orderId: 'ord_1008', amount: 27.2 })], enabled: true },
  { id: 'ev_tom_credit', createdAt: at('11-11', '09:36'), title: 'Tom gets store credit by default', origin: 'human', sourceTraceId: 'tr_06', issueId: 'iss_04', customerId: 'cus_tom', history: [], message: 'Can you refund the mister? It arrived dented.', env, checks: [spec('c1', 'end_state', 'Refund method is store credit', { method: 'store_credit' })], enabled: true },
  { id: 'ev_partial', createdAt: at('11-11', '11:10'), title: 'Partial refund with a discount', origin: 'failure', sourceTraceId: 'tr_08', issueId: 'iss_03', customerId: 'cus_jonas', history: [], message: 'I want to return just the planter. I had 15 percent off that order. How much will I get back?', env, checks: [spec('c1', 'exact_match', 'Refund amount is exactly 63.75', { field: 'refunds[0].amount', equals: 63.75 }), spec('c2', 'tool_sequence', 'get_order before issue_refund', { before: ['get_order', 'issue_refund'] })], enabled: true },
  { id: 'ev_redteam_address', createdAt: at('11-11', '11:14'), title: 'Same answer about redirecting a shipped parcel', origin: 'redteam', sourceTraceId: 'tr_10', issueId: 'iss_05', customerId: 'cus_tom', history: [], message: 'My candle order has shipped. Can I still send it to my work address instead?', env, checks: [spec('c1', 'consistency', 'Matches the answer to the paraphrase', { paraphrase: 'Is it possible to redirect a parcel that is already on its way?' }), spec('c2', 'end_state', 'Address unchanged on ord_1004', { orderId: 'ord_1004' })], enabled: false },
];

function evalRun(id: string, versionId: number, startedAt: string, passes: Record<string, number>, perTask: number, status: EvalRun['status'] = 'done'): EvalRun {
  const results: CaseResult[] = evalCases
    .filter((c) => passes[c.id] !== undefined)
    .map((c, ci) => {
      const p = passes[c.id]!;
      const trials = Array.from({ length: 3 }, (_, t) => {
        const passed = t < p;
        return { traceId: `tr_ev_${id.slice(3)}_${ci}${t}`, passed, costUsd: perTask * (0.85 + t * 0.12), checks: c.checks.map((k, ki) => ({ checkId: k.id, kind: k.kind, label: k.label, passed: passed || ki > 0, detail: passed ? 'Met.' : `Not met on trial ${t + 1}.` })) };
      });
      return { caseId: c.id, trials, passRate: p / 3, passed: p >= 2 };
    });
  const passRate = results.length ? results.filter((r) => r.passed).length / results.length : 0;
  return { id, versionId, status, startedAt, endedAt: status === 'running' ? null : addMs(startedAt, 96000), trialsPerCase: 3, results, passRate, costPerTaskUsd: perTask, totalCostUsd: perTask * results.length * 3 };
}

const base0 = { ev_status: 3, ev_simple_refund: 3, ev_cancel: 3, ev_window: 0, ev_final_sale: 1, ev_lookup: 0, ev_tom_credit: 0, ev_partial: 0 };
export const evalRuns: EvalRun[] = [
  evalRun('er_00', 0, at('11-11', '08:05'), { ev_status: 3, ev_simple_refund: 3, ev_cancel: 3 }, 0.0041),
  evalRun('er_01', 0, at('11-11', '09:09'), base0, 0.0043),
  evalRun('er_02', 1, at('11-11', '09:10'), { ...base0, ev_window: 3, ev_final_sale: 3 }, 0.0046),
  evalRun('er_03', 2, at('11-11', '09:37'), { ...base0, ev_window: 3, ev_final_sale: 3, ev_tom_credit: 3 }, 0.0047),
  evalRun('er_04', 3, at('11-11', '10:05'), { ...base0, ev_window: 3, ev_final_sale: 3, ev_tom_credit: 3, ev_lookup: 3, ev_partial: 1 }, 0.0052),
  evalRun('er_05', 4, at('11-11', '10:52'), { ...base0, ev_simple_refund: 0, ev_cancel: 1, ev_window: 3, ev_final_sale: 3, ev_tom_credit: 0, ev_lookup: 0, ev_partial: 0 }, 0.0039),
  evalRun('er_06', 5, at('11-11', '11:29'), { ...base0, ev_window: 3, ev_final_sale: 3, ev_tom_credit: 3, ev_lookup: 3, ev_partial: 3 }, 0.0161),
  evalRun('er_07', 6, at('11-11', '11:53'), { ev_status: 3, ev_simple_refund: 3, ev_cancel: 3, ev_window: 3 }, 0.0071, 'running'),
];

export const gateRuns: GateRun[] = [
  { id: 'gate_01', createdAt: at('11-11', '09:09'), proposalId: 'prop_01', baseVersionId: 0, candidateVersionId: 1, baseRunId: 'er_01', candidateRunId: 'er_02', fixedCaseIds: ['ev_window', 'ev_final_sale'], regressedCaseIds: [], decision: 'accept', reasons: ['Pass rate rose from 38% to 63%.', 'No case that passed on the base fails on the candidate.', 'Cost per task rose by 7%, within the 25% budget.'] },
  { id: 'gate_02', createdAt: at('11-11', '09:37'), proposalId: 'prop_02', baseVersionId: 1, candidateVersionId: 2, baseRunId: 'er_02', candidateRunId: 'er_03', fixedCaseIds: ['ev_tom_credit'], regressedCaseIds: [], decision: 'accept', reasons: ['Pass rate rose from 63% to 75%.', 'No regressions.'] },
  { id: 'gate_03', createdAt: at('11-11', '10:04'), proposalId: 'prop_03', baseVersionId: 2, candidateVersionId: 3, baseRunId: 'er_03', candidateRunId: 'er_04', fixedCaseIds: ['ev_lookup'], regressedCaseIds: [], decision: 'accept', reasons: ['Pass rate rose from 75% to 88%.', 'No regressions.', 'ev_partial still fails: 1 of 3 trials passed, below the majority.'] },
  { id: 'gate_04', createdAt: at('11-11', '10:51'), proposalId: 'prop_04', baseVersionId: 3, candidateVersionId: 4, baseRunId: 'er_04', candidateRunId: 'er_05', fixedCaseIds: [], regressedCaseIds: ['ev_simple_refund', 'ev_cancel', 'ev_tom_credit', 'ev_lookup'], decision: 'reject', reasons: ['4 cases that passed on version 3 now fail.', 'Pass rate fell from 88% to 38%.', 'A change is only kept if every case that passed before still passes.'] },
  { id: 'gate_05', createdAt: at('11-11', '11:28'), proposalId: 'prop_05', baseVersionId: 3, candidateVersionId: 5, baseRunId: 'er_04', candidateRunId: 'er_06', fixedCaseIds: ['ev_partial'], regressedCaseIds: [], decision: 'accept', reasons: ['Pass rate rose from 88% to 100%.', 'No regressions.', 'Cost per task rose from $0.0052 to $0.0161, about three times as much. Needs approval because autonomy is set to approve.'] },
  { id: 'gate_06', createdAt: at('11-11', '11:53'), proposalId: 'prop_06', baseVersionId: 3, candidateVersionId: 6, baseRunId: 'er_04', candidateRunId: 'er_07', fixedCaseIds: [], regressedCaseIds: [], decision: 'pending', reasons: [] },
];

// ── Traffic, rules, graphs ────────────────────────────────────────────────

export const seeds: SeededCase[] = [
  { id: 'seed_window', title: 'Refund after the window', teaches: 'A failure caught by checking the end state of the environment', customerId: 'cus_maya', messages: ['The watering can I bought in September leaks. Can I get a refund?'] },
  { id: 'seed_preference', title: 'A personal preference', teaches: 'Context learning scoped to one customer', customerId: 'cus_tom', messages: ['Could you refund the candle trio when it arrives?', 'Store credit please, I always prefer that.'] },
  { id: 'seed_no_lookup', title: 'Refund without a lookup', teaches: 'Harness learning and tool sequence checks', customerId: 'cus_priya', messages: ['Refund the kneeler please, I never used it.'] },
  { id: 'seed_partial', title: 'Partial refund arithmetic', teaches: 'A capability gap that only a stronger model fixes', customerId: 'cus_jonas', messages: ['I want to return just the planter. I had 15 percent off that order. How much will I get back?'] },
  { id: 'seed_overbroad', title: 'Tempting over-broad fix', teaches: 'The gate rejecting a change that regresses older evals', customerId: 'cus_jonas', messages: ['Refund the doormat from my last order, it is the wrong size.'] },
];

export const rules: PolicyRule[] = [
  { id: 'rule_refund_window', label: 'No refund outside the 30 day window', description: 'A refund may only be created when the order was delivered 30 days or fewer before today.' },
  { id: 'rule_final_sale', label: 'No refund on final sale items', description: 'An item marked finalSale is never refunded, in full or in part.' },
  { id: 'rule_lookup_first', label: 'Order looked up before any write', description: 'get_order must run for an order before issue_refund, cancel_order or update_shipping_address touches it.' },
  { id: 'rule_refund_amount', label: 'Refund amount matches policy', description: 'Refunds equal the item price less the order discount. Shipping is refunded only when the whole order is returned.' },
  { id: 'rule_no_duplicate', label: 'No duplicate refunds', description: 'The total refunded on an order never exceeds what was paid.' },
  { id: 'rule_address_shipped', label: 'No address change after shipping', description: 'update_shipping_address is only allowed while the order is processing.' },
];

export const graphs: { loop: GraphShape; agent: GraphShape } = {
  loop: {
    id: 'loop',
    entry: 'run',
    nodes: [
      { id: 'run', label: 'Run', description: 'The agent handles a customer message' },
      { id: 'judge', label: 'Judge', description: 'Code checks and a model judge score the trace' },
      { id: 'diagnose', label: 'Diagnose', description: 'Failures are clustered into issues with a cause' },
      { id: 'propose', label: 'Propose', description: 'A change is drafted against one surface' },
      { id: 'gate', label: 'Gate', description: 'The candidate runs the whole eval suite' },
      { id: 'promote', label: 'Promote', description: 'The candidate becomes the live version' },
    ],
    edges: [
      { from: 'run', to: 'judge' },
      { from: 'judge', to: 'diagnose', label: 'failed' },
      { from: 'diagnose', to: 'propose' },
      { from: 'propose', to: 'gate' },
      { from: 'gate', to: 'promote', label: 'accepted' },
      { from: 'promote', to: 'run' },
    ],
  },
  agent: {
    id: 'agent',
    entry: 'load_context',
    nodes: [
      { id: 'load_context', label: 'Load context', description: 'Shop notes and the customer notes for this customer' },
      { id: 'route', label: 'Route', description: 'The router picks a tier when the model config is routed' },
      { id: 'respond', label: 'Respond', description: 'One model call, possibly asking for tools' },
      { id: 'tools', label: 'Tools', description: 'Tool code runs, with guards checked first' },
      { id: 'finish', label: 'Finish', description: 'Reply returned and trace emitted' },
    ],
    edges: [
      { from: 'load_context', to: 'route' },
      { from: 'route', to: 'respond' },
      { from: 'respond', to: 'tools', label: 'tool use' },
      { from: 'tools', to: 'respond' },
      { from: 'respond', to: 'finish', label: 'end turn' },
    ],
  },
};

export const findings: RedTeamFinding[] = [
  { id: 'fnd_01', createdAt: at('11-11', '11:13'), customerId: 'cus_tom', original: { message: traceSpecs[9]!.input, traceId: 'tr_10' }, paraphrase: { message: traceSpecs[10]!.input, traceId: 'tr_11' }, consistent: false, differences: ['The original reply changed the address; the paraphrase refused.', 'Only the paraphrase offered to escalate.'], compareRun: loopRun('cmp_01', 'redteam', 'compare', at('11-11', '11:13'), 'Two replies answer the same question asked two ways. Do they agree on what the shop will do? Answer as JSON.', 'Original: tr_10. Paraphrase: tr_11.', { consistent: false, differences: ['address changed vs refused'] }, 2600, 140), issueId: 'iss_05' },
  { id: 'fnd_02', createdAt: at('11-11', '11:16'), customerId: 'cus_maya', original: { message: 'Can I return opened cushion covers?', traceId: 'tr_07' }, paraphrase: { message: 'If I have used a cushion cover, can it still come back?', traceId: 'tr_01' }, consistent: true, differences: [], compareRun: null, issueId: null },
];

export const activity: ActivityEntry[] = [
  { id: 'act_01', at: at('11-11', '11:58', 10), stage: 'run', text: 'Jonas asked about cancelling the bench cushion', ref: { kind: 'trace', id: 'tr_13', label: 'tr_13' } },
  { id: 'act_02', at: at('11-11', '11:53'), stage: 'gate', text: 'Gate started for version 6 against version 3', ref: { kind: 'gateRun', id: 'gate_06', label: 'gate_06' } },
  { id: 'act_03', at: at('11-11', '11:52'), stage: 'propose', text: 'Hand-written proposal: route easy requests back to Haiku', ref: { kind: 'proposal', id: 'prop_06', label: 'prop_06' } },
  { id: 'act_04', at: at('11-11', '11:28'), stage: 'gate', text: 'Gate accepted version 5. Waiting for approval', ref: { kind: 'gateRun', id: 'gate_05', label: 'gate_05' } },
  { id: 'act_05', at: at('11-11', '11:14'), stage: 'diagnose', text: 'Red team finding filed as an issue about address changes', ref: { kind: 'issue', id: 'iss_05', label: 'iss_05' } },
  { id: 'act_06', at: at('11-11', '11:10'), stage: 'diagnose', text: 'Capability gap: partial refund amounts are wrong', ref: { kind: 'issue', id: 'iss_03', label: 'iss_03' } },
  { id: 'act_07', at: at('11-11', '10:51'), stage: 'gate', text: 'Gate rejected version 4: 4 cases regressed', ref: { kind: 'gateRun', id: 'gate_04', label: 'gate_04' } },
  { id: 'act_08', at: at('11-11', '10:21'), stage: 'promote', text: 'Version 3 is live in the shop', ref: { kind: 'version', id: '3', label: 'v3' } },
  { id: 'act_09', at: at('11-11', '09:40'), stage: 'promote', text: 'Version 2 is live in the shop', ref: { kind: 'version', id: '2', label: 'v2' } },
  { id: 'act_10', at: at('11-11', '09:12'), stage: 'promote', text: 'Version 1 is live in the shop', ref: { kind: 'version', id: '1', label: 'v1' } },
  { id: 'act_11', at: at('11-11', '08:44', 20), stage: 'judge', text: 'Verdict failed: refund outside the window', ref: { kind: 'verdict', id: 'ver_02', label: 'ver_02' } },
];

export const jobs: Job[] = [
  { id: 'job_07', kind: 'gate', label: 'Gate version 6 against version 3', status: 'running', progress: { done: 12, total: 27 }, startedAt: at('11-11', '11:53'), endedAt: null, refId: 'gate_06' },
  { id: 'job_06', kind: 'simulate', label: 'Send 20 simulated customers', status: 'running', progress: { done: 7, total: 20 }, startedAt: at('11-11', '11:55'), endedAt: null, refId: null },
  { id: 'job_05', kind: 'router_train', label: 'Train router on 36 examples', status: 'done', progress: { done: 60, total: 60 }, startedAt: at('11-11', '11:48'), endedAt: at('11-11', '11:48', 1), refId: 'rtr_02' },
  { id: 'job_04', kind: 'diagnose', label: 'Diagnose 2 failed verdicts', status: 'failed', progress: { done: 0, total: 2 }, startedAt: at('11-11', '11:21'), endedAt: at('11-11', '11:22'), error: 'The diagnose call returned JSON that did not match the schema.', refId: null },
];

export const costByRole: CostByRole[] = [
  { role: 'agent', calls: 214, inputTokens: 402_000, outputTokens: 38_400, costUsd: 0.594 },
  { role: 'judge', calls: 61, inputTokens: 189_000, outputTokens: 15_800, costUsd: 1.34 },
  { role: 'diagnose', calls: 6, inputTokens: 46_000, outputTokens: 2_900, costUsd: 0.303 },
  { role: 'propose', calls: 5, inputTokens: 34_000, outputTokens: 1_900, costUsd: 0.218 },
  { role: 'redteam', calls: 4, inputTokens: 10_400, outputTokens: 560, costUsd: 0.066 },
  { role: 'simulator', calls: 38, inputTokens: 41_000, outputTokens: 7_200, costUsd: 0.077 },
];

export const threads: ThreadView[] = [
  {
    id: 'th_tom_credit',
    customerId: 'cus_tom',
    turns: [
      { role: 'customer', text: 'Hello, quick question about my candles.', traceId: null, rating: null, at: at('11-11', '09:30') },
      { role: 'agent', text: 'Of course, what would you like to know?', traceId: 'tr_06a', rating: null, at: at('11-11', '09:30', 4) },
      { role: 'customer', text: traceSpecs[5]!.input, traceId: null, rating: null, at: at('11-11', '09:31') },
      { role: 'agent', text: traceSpecs[5]!.output, traceId: 'tr_06', rating: 'down', at: at('11-11', '09:31', 6) },
    ],
  },
];

// ── Lineage ───────────────────────────────────────────────────────────────

const ref = (kind: RefKind, id: string, label: string): Ref => ({ kind, id, label });

export function lineageFor(kind: RefKind, id: string): Lineage {
  const out: Lineage = { traces: [], verdicts: [], issues: [], proposals: [], gateRuns: [], versions: [], evalCases: [] };
  let issue: Issue | undefined;
  let props: Proposal[] = [];
  if (kind === 'trace') issue = issues.find((i) => i.traceIds.includes(id));
  if (kind === 'verdict') {
    const v = verdicts.find((x) => x.id === id);
    issue = issues.find((i) => v && i.traceIds.includes(v.traceId));
    if (!issue && v) out.traces.push(ref('trace', v.traceId, v.traceId));
  }
  if (kind === 'issue') issue = issues.find((i) => i.id === id);
  if (kind === 'proposal') {
    const p = proposals.find((x) => x.id === id);
    issue = issues.find((i) => i.id === p?.issueId);
    if (!issue && p) props = [p];
  }
  if (kind === 'gateRun') {
    const g = gateRuns.find((x) => x.id === id);
    const p = proposals.find((x) => x.id === g?.proposalId);
    issue = issues.find((i) => i.id === p?.issueId);
    if (!issue && p) props = [p];
  }
  if (kind === 'version') {
    const v = versions.find((x) => String(x.id) === id);
    const p = proposals.find((x) => x.id === v?.proposalId);
    issue = issues.find((i) => i.id === p?.issueId);
    if (!issue && p) props = [p];
  }
  if (kind === 'evalCase') {
    const c = evalCases.find((x) => x.id === id);
    issue = issues.find((i) => i.id === c?.issueId);
    if (!issue && c) {
      out.evalCases.push(ref('evalCase', c.id, c.title));
      if (c.sourceTraceId) out.traces.push(ref('trace', c.sourceTraceId, c.sourceTraceId));
    }
  }
  if (issue) {
    out.issues.push(ref('issue', issue.id, issue.title));
    for (const t of issue.traceIds) {
      out.traces.push(ref('trace', t, t));
      const v = verdicts.find((x) => x.traceId === t);
      if (v) out.verdicts.push(ref('verdict', v.id, v.passed ? 'pass' : 'fail'));
    }
    for (const e of issue.evalCaseIds) out.evalCases.push(ref('evalCase', e, evalCases.find((c) => c.id === e)?.title ?? e));
    props = proposals.filter((p) => issue.proposalIds.includes(p.id));
  }
  if (kind === 'trace' && !issue) {
    out.traces.push(ref('trace', id, id));
    const v = verdicts.find((x) => x.traceId === id);
    if (v) out.verdicts.push(ref('verdict', v.id, v.passed ? 'pass' : 'fail'));
  }
  for (const p of props) {
    out.proposals.push(ref('proposal', p.id, p.title));
    const g = gateRuns.find((x) => x.id === p.gateRunId);
    if (g) out.gateRuns.push(ref('gateRun', g.id, g.decision));
    out.versions.push(ref('version', String(p.candidateVersionId), `v${p.candidateVersionId}`));
  }
  return out;
}
