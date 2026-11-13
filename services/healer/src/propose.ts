import { z } from 'zod';
import {
  LlmError,
  LOOP_MODEL_ID,
  TOOL_NAMES,
  type AgentVersion,
  type Change,
  type Issue,
  type Job,
  type Proposal,
  type Run,
  type Tier,
  type ToolName,
} from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import * as describe from './describe.ts';

// ── Changes ──

const toolName = z.enum(TOOL_NAMES as [ToolName, ...ToolName[]]);
const tier = z.enum(['haiku', 'sonnet', 'opus']);
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const scope = z.discriminatedUnion('kind', [z.object({ kind: z.literal('shop') }), z.object({ kind: z.literal('customer'), customerId: z.string().min(1) })]);
const guards = z.object({
  requireOrderLookupBeforeWrite: z.boolean().optional(),
  blockDuplicateRefund: z.boolean().optional(),
  refundEscalationThreshold: z.number().positive().nullable().optional(),
});

const router = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  vocabulary: z.array(z.string()),
  weights: z.array(z.number()),
  bias: z.number(),
  threshold: z.number().min(0).max(1),
  metrics: z.object({
    trainSize: z.number().int(),
    valSize: z.number().int(),
    trainAccuracy: z.number(),
    valAccuracy: z.number(),
    lossCurve: z.array(z.number()),
    trainPositives: z.number().int(),
    valPositives: z.number().int(),
    valRecall: z.number().nullable(),
  }),
}).refine((r) => r.weights.length === r.vocabulary.length, 'A router needs one weight per vocabulary word');

const model = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), tier, effort }),
  z.object({ mode: z.literal('routed'), easyTier: tier, hardTier: tier, effort, router }),
]);

// Validates a Change[] at the HTTP boundary.
export const changeSchema = z.union([
  z.object({ surface: z.literal('context'), op: z.literal('add'), scope, text: z.string().min(1) }),
  z.object({ surface: z.literal('context'), op: z.literal('edit'), noteId: z.string(), text: z.string().min(1) }),
  z.object({ surface: z.literal('context'), op: z.literal('remove'), noteId: z.string() }),
  z.object({ surface: z.literal('harness'), op: z.literal('set_system_prompt'), systemPrompt: z.string().min(1) }),
  z.object({ surface: z.literal('harness'), op: z.literal('set_tool'), name: toolName, description: z.string().min(1).optional(), enabled: z.boolean().optional() }),
  z.object({ surface: z.literal('harness'), op: z.literal('set_guards'), guards }),
  z.object({ surface: z.literal('model'), op: z.literal('set_model'), model }),
]);

export class ChangeError extends Error {}

// Applies changes to a copy of `base`. The caller fills in the new version's identity.
export function applyChanges(base: AgentVersion, changes: Change[], meta: Pick<AgentVersion, 'id' | 'author' | 'summary' | 'proposalId'> & { issueId: string | null }): AgentVersion {
  const v: AgentVersion = {
    ...structuredClone(base),
    id: meta.id,
    parentId: base.id,
    createdAt: now(),
    author: meta.author,
    summary: meta.summary,
    status: 'candidate',
    proposalId: meta.proposalId,
    gated: true,
  };
  for (const change of changes) {
    if (change.surface === 'context') {
      if (change.op === 'add') {
        v.context.push({ id: newId('note'), scope: change.scope, text: change.text, addedInVersion: v.id, issueId: meta.issueId });
        continue;
      }
      const note = v.context.find((n) => n.id === change.noteId);
      if (!note) throw new ChangeError(`There is no context note ${change.noteId}`);
      if (change.op === 'edit') Object.assign(note, { text: change.text, addedInVersion: v.id, issueId: meta.issueId });
      else v.context = v.context.filter((n) => n !== note);
    } else if (change.surface === 'harness') {
      if (change.op === 'set_system_prompt') v.harness.systemPrompt = change.systemPrompt;
      else if (change.op === 'set_guards') v.harness.guards = { ...v.harness.guards, ...change.guards };
      else {
        const tool = v.harness.tools.find((t) => t.name === change.name)!;
        if (change.description !== undefined) tool.description = change.description;
        if (change.enabled !== undefined) tool.enabled = change.enabled;
      }
    } else {
      v.model = structuredClone(change.model);
    }
  }
  return v;
}

const TIERS: Tier[] = ['haiku', 'sonnet', 'opus'];

export function nextTier(v: AgentVersion): Tier | null {
  const current = v.model.mode === 'fixed' ? v.model.tier : v.model.hardTier;
  return TIERS[TIERS.indexOf(current) + 1] ?? null;
}

// ── Proposals ──

export const isOpenProposal = (p: Proposal) => p.status === 'draft' || p.status === 'gating' || p.status === 'awaiting_approval';

export function createProposal(
  h: Healer,
  input: { author: Proposal['author']; issueId: string | null; title: string; rationale: string; changes: Change[]; proposeRun: Run | null },
  verb = input.author === 'loop' ? 'Proposed' : 'Hand-written proposal',
): Proposal {
  const { store } = h;
  const base = store.liveVersion()!;
  const proposal: Proposal = {
    id: newId('prop'),
    createdAt: now(),
    author: input.author,
    issueId: input.issueId,
    title: input.title,
    rationale: input.rationale,
    baseVersionId: base.id,
    candidateVersionId: store.nextVersionId(),
    changes: input.changes,
    status: 'draft',
    gateRunId: null,
    proposeRun: input.proposeRun,
  };
  const candidate = applyChanges(base, input.changes, {
    id: proposal.candidateVersionId,
    author: input.author === 'loop' ? 'loop' : 'human',
    summary: input.title,
    proposalId: proposal.id,
    issueId: input.issueId,
  });
  store.versions.put(candidate);
  store.proposals.put(proposal);
  if (input.issueId) {
    const issue = store.issues.get(input.issueId)!;
    issue.proposalIds.push(proposal.id);
    issue.status = 'proposed';
    issue.updatedAt = now();
    store.issues.put(issue);
  }
  h.activity('propose', `${verb}: ${proposal.title} (candidate version ${candidate.id})`, {
    kind: 'proposal',
    id: proposal.id,
    label: proposal.title,
  });
  h.changed('proposal', 'version', 'issue');
  return proposal;
}

// A new draft with the same changes, issue and title as `p`, built on the live version. Throws ChangeError when the
// changes no longer apply there, for example an edit to a note the live version no longer has.
export function proposeAgain(h: Healer, p: Proposal, verb: string): Proposal {
  const live = h.store.liveVersion()!;
  try {
    return createProposal(h, { author: p.author, issueId: p.issueId, title: p.title, rationale: p.rationale, changes: p.changes, proposeRun: p.proposeRun }, verb);
  } catch (err) {
    if (err instanceof ChangeError) throw new ChangeError(`The changes no longer apply to live version ${live.id}: ${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}.`);
    throw err;
  }
}

export function discardProposal(h: Healer, proposal: Proposal, why = ''): Proposal {
  const { store } = h;
  const discarded = store.proposals.put({ ...proposal, status: 'discarded' });
  store.versions.put({ ...store.versions.get(proposal.candidateVersionId)!, status: 'rejected' });
  const issue = proposal.issueId ? store.issues.get(proposal.issueId) : null;
  if (issue && issue.status === 'proposed' && !issue.proposalIds.some((id) => isOpenProposal(store.proposals.get(id)!))) {
    store.issues.put({ ...issue, status: 'open', updatedAt: now() });
  }
  h.activity('propose', `Discarded proposal: ${proposal.title}${why}`, { kind: 'proposal', id: proposal.id, label: proposal.title });
  h.changed('proposal', 'version', 'issue');
  return discarded;
}

export const PROPOSE_SYSTEM = `You propose a change to the customer support agent of Pocket Meadow, an online shop selling home and garden goods, to fix one issue found in its conversations. You see the issue, some of the conversations that failed with the checks they failed, and the agent version now live.

Make the smallest change that fixes the whole class of failure, not only the conversations shown, without breaking normal service. The agent must keep doing everything the shop allows: refunds that policy permits, cancellations and address changes on orders still processing, and answers to questions about orders. Every change is tested against a suite of past failures and normal requests before it ships, and a change that stops the agent doing allowed work is rejected.

Learn the shop's rules only from the failed checks. State a rule exactly as they state it, with its numbers, and add no rule they do not establish. Write for the agent: plain, direct sentences it can act on.`;

const SURFACE_GUIDE = {
  context: `This issue is fixed in the context: short notes the agent reads in every conversation, under "Shop notes" (scope shop) or "Notes about this customer" (scope customer). A new note gets this issue's scope. One note per rule. Edit an existing note rather than adding one that overlaps it, and remove a note only if it is wrong.`,
  customer: `A note for one customer records only what the shop is free to honour whatever its rules say: a name to use, tone, language, how or when to contact them. Never write a customer note that asks for, promises or changes anything about refunds, payment or refund methods, money, eligibility, deadlines or exceptions to a rule; shop policy decides those for every customer. Read the notes this customer already has in the live version first. If the new preference contradicts or updates one of them (for example a different name to use), edit that note to what the customer wants now, or remove it, instead of adding a second note: the customer's latest statement wins.`,
  harness: `This issue is fixed in the harness. You can rewrite the system prompt (give the full new text, keeping what still applies), change a tool's description or enable or disable it, or switch on guards enforced in code:
- requireOrderLookupBeforeWrite: a write tool is refused unless get_order or list_orders returned that order earlier and it belongs to the current customer.
- blockDuplicateRefund: a second refund on an order is refused.
- refundEscalationThreshold: refunds above this amount are refused and the agent is told to escalate to a human (null turns it off).
A guard is the strongest fix for a rule that must never be broken; prompt and tool text fix how the agent works.`,
};

const contextChange = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), text: z.string() }),
  z.object({ op: z.literal('edit'), noteId: z.string(), text: z.string() }),
  z.object({ op: z.literal('remove'), noteId: z.string() }),
]);

const harnessChange = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_system_prompt'), systemPrompt: z.string() }),
  z.object({ op: z.literal('set_tool'), name: toolName, description: z.string().optional(), enabled: z.boolean().optional() }),
  z.object({ op: z.literal('set_guards'), guards }),
]);

const proposalOutput = <T extends z.ZodType>(change: T) =>
  z.object({
    title: z.string().describe('A short title for the change'),
    rationale: z.string().describe('Why this change fixes the class of failure and why it will not break normal service'),
    changes: z.array(change),
  });

type ProposalOutput = { title: string; rationale: string; changes: (z.infer<typeof contextChange> | z.infer<typeof harnessChange>)[] };

function previousAttempts(h: Healer, issue: Issue): string {
  const rejected = issue.proposalIds
    .map((id) => h.store.proposals.get(id)!)
    .filter((p) => p.status === 'rejected' && p.gateRunId)
    .slice(-2);
  if (!rejected.length) return '';
  const attempts = rejected.map((p, i) => {
    const gate = h.store.gateRuns.get(p.gateRunId!)!;
    return `Attempt ${i + 1}: ${p.title}\nChanges: ${JSON.stringify(p.changes)}\nRejected by the eval gate because:\n${gate.reasons.map((r) => `- ${r}`).join('\n')}`;
  });
  return `\n\n<rejected_attempts>\n${attempts.join('\n\n')}\n</rejected_attempts>\nYour new proposal must fix the issue without repeating what made these fail.`;
}

const MAX_EXAMPLES = 3;

// Proposes a fix for one issue. Model issues need no creativity: the proposal is the next tier up.
export async function proposeForIssue(h: Healer, issueId: string): Promise<Proposal> {
  const { store } = h;
  const issue = store.issues.get(issueId);
  if (!issue) throw new Error(`Unknown issue ${issueId}`);
  const existing = issue.proposalIds.map((id) => store.proposals.get(id)!).find(isOpenProposal);
  if (existing) throw new Error(`Issue ${issueId} already has an open proposal (${existing.id})`);
  const live = store.liveVersion()!;

  if (issue.surface === 'model') {
    const up = nextTier(live);
    if (!up) throw new Error('The agent is already on the top model tier');
    const from = live.model.mode === 'fixed' ? live.model.tier : live.model.hardTier;
    return createProposal(h, {
      author: 'loop',
      issueId,
      title: `Move the agent from ${from} to ${up}`,
      rationale: `"${issue.title}" was diagnosed as a capability gap: the agent had the rule and the procedure and still got it wrong. The next tier up is the remaining lever; the gate shows whether the pass rate gain is worth the higher cost per task.`,
      changes: [{ surface: 'model', op: 'set_model', model: { mode: 'fixed', tier: up, effort: live.model.effort } }],
      proposeRun: null,
    });
  }

  const examples = issue.traceIds.slice(-MAX_EXAMPLES).map((id) => {
    const trace = store.trace(id)!;
    return describe.failure(trace, store.verdictForTrace(id)?.checks ?? []);
  });
  const scope = issue.scope.kind === 'shop' ? 'shop' : `customer ${issue.scope.customerId}`;
  const message = [
    '<issue>',
    `${issue.title}\nCause: ${issue.cause}. Surface: ${issue.surface}. Scope: ${scope}.\n${issue.summary}`,
    '</issue>',
    '',
    ...examples.map((e, i) => `<failed_conversation n="${i + 1}">\n${e}\n</failed_conversation>\n`),
    '<live_version>',
    describe.version(live),
    '</live_version>',
  ].join('\n');
  const guide = issue.surface === 'context' && issue.scope.kind === 'customer' ? `${SURFACE_GUIDE.context}\n\n${SURFACE_GUIDE.customer}` : SURFACE_GUIDE[issue.surface];
  const system = `${PROPOSE_SYSTEM}\n\n${guide}${previousAttempts(h, issue)}`;

  const schema: z.ZodType<ProposalOutput> = issue.surface === 'context' ? proposalOutput(contextChange) : proposalOutput(harnessChange);
  let result;
  try {
    result = await h.llm().json({ role: 'propose', model: LOOP_MODEL_ID, effort: 'medium', system, messages: [{ role: 'user', content: message }], schema });
  } catch (err) {
    if (err instanceof LlmError) h.recordRun(err.run);
    throw err;
  }
  h.recordRun(result.run);
  const out = result.value;
  if (!out.changes.length) throw new Error('The proposal contained no changes');
  const changes = out.changes.map((c): Change => {
    if (c.op === 'add') return { surface: 'context', op: 'add', scope: issue.scope, text: c.text };
    if (c.op === 'edit' || c.op === 'remove') return { surface: 'context', ...c };
    return { surface: 'harness', ...c };
  });
  return createProposal(h, { author: 'loop', issueId, title: out.title, rationale: out.rationale, changes, proposeRun: result.run });
}

export function startProposeJob(h: Healer, issueId: string): Job {
  return h.startJob('propose', `Propose a fix for issue ${issueId}`, issueId, (job) =>
    h.stage('propose', 'Propose a fix', async () => {
      await proposeForIssue(h, issueId);
      job.progress(1, 1);
    }),
  );
}
