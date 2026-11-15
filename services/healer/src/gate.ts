import { predictRoute, type CaseResult, type EvalRun, type GateRun, type Job, type Proposal, type Tier } from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import { runSuite } from './evalRunner.ts';
import { ChangeError, discardProposal, isOpenProposal, preferenceScopeRefusal, proposeAgain } from './propose.ts';

export interface GateDecision {
  decision: 'accept' | 'reject';
  fixedCaseIds: string[];
  regressedCaseIds: string[];
  reasons: string[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number) => `$${n.toFixed(4)}`;

function failingDetail(result: CaseResult | undefined): string {
  const trial = result?.trials.find((t) => !t.passed);
  const check = trial?.checks.find((c) => !c.passed);
  return check ? ` In a failing trial, "${check.label}" failed: ${check.detail}` : '';
}

// The chance that a request failing one time in `oneIn` shows at least one failure in `trials` trials.
export const detectionChance = (trials: number, oneIn = 5) => 1 - (1 - 1 / oneIn) ** trials;

// What the gate could see of one strict case: each side's trials, the detection chance at this trial count, why the
// candidate failed, and, when the base already failed, that the case could not count as a regression.
function strictReason(title: string, base: CaseResult, cand: CaseResult, baseId: number, candId: number, trials: number): string {
  const side = (r: CaseResult, v: number) => {
    if (r.passed) return `passed ${r.trials.length} of ${r.trials.length} trials on version ${v}`;
    const skipped = trials - r.trials.length;
    return `failed trial ${r.trials.findIndex((t) => !t.passed) + 1} on version ${v}${skipped ? `, so its other ${skipped} were skipped` : ''}`;
  };
  const sides = base.passed && cand.passed ? `passed ${trials} of ${trials} trials on version ${baseId} and on version ${candId}` : `${side(base, baseId)}, and ${side(cand, candId)}`;
  const parts = [
    `Strict: "${title}" ${sides}.`,
    `A request that fails 1 time in 5 would show at least one failure in ${trials} trials ${pct(detectionChance(trials))} of the time.`,
  ];
  if (!base.passed) parts.push(`Because it already fails on version ${baseId}, it counts as failing on the base and cannot regress, so this gate could not use it.`);
  const check = (cand.passed ? base : cand).trials.find((t) => !t.passed)?.checks.find((c) => !c.passed);
  const where = cand.passed ? `On version ${baseId}` : 'In the failing trial';
  return parts.join(' ') + (check ? ` ${where}, "${check.label}" failed: ${check.detail}` : '');
}

// How a routed candidate sends the eval cases that belong to capability issues. Decided by the router's weights
// alone, so unlike pass rates it does not depend on how the trials happened to fall.
export interface RoutingCheck {
  easyTier: Tier;
  hardTier: Tier;
  cases: { caseId: string; score: number; needsStrong: boolean }[];
  // How many requests in the router dataset it sends to the hard tier, which is where the saving comes from.
  dataset: { size: number; toHard: number };
}

// Accept only if no case regressed, the pass rate did not drop, (for a proposal fixing an issue) at least one
// of that issue's eval cases passes on the candidate, and (for a routed model) every capability case goes to the
// strong tier. A change made only to save money (`costFirst`) is judged the same way, but its reasons lead with
// what it does to cost per task.
export function decide(
  base: EvalRun,
  candidate: EvalRun,
  issueCaseIds: string[] | null,
  title: (caseId: string) => string,
  { costFirst = false, routing = null }: { costFirst?: boolean; routing?: RoutingCheck | null } = {},
): GateDecision {
  const baseBy = new Map(base.results.map((r) => [r.caseId, r]));
  const common = candidate.results.filter((r) => baseBy.has(r.caseId));
  const basePassed = common.filter((r) => baseBy.get(r.caseId)!.passed).length;
  const candPassed = common.filter((r) => r.passed).length;
  const regressed = common.filter((r) => baseBy.get(r.caseId)!.passed && !r.passed);
  const fixed = common.filter((r) => !baseBy.get(r.caseId)!.passed && r.passed);
  const trials = (r: CaseResult) => `${r.trials.filter((t) => t.passed).length} of ${r.trials.length} trials passed`;

  const reasons: string[] = [];
  const failures: string[] = [];
  if (regressed.length) failures.push(`${regressed.length} case${regressed.length > 1 ? 's' : ''} that passed before now fail${regressed.length > 1 ? '' : 's'}`);
  if (candPassed < basePassed) failures.push('the pass rate dropped');

  const issueCases = issueCaseIds ? candidate.results.filter((r) => issueCaseIds.includes(r.caseId)) : [];
  const issueFixed = issueCases.filter((r) => r.passed);
  if (issueCases.length && !issueFixed.length) failures.push("none of the issue's own eval cases passes");
  const misrouted = routing?.cases.filter((c) => !c.needsStrong) ?? [];
  if (misrouted.length) failures.push(`${misrouted.length} capability case${misrouted.length > 1 ? 's are' : ' is'} routed to ${routing!.easyTier}`);

  const n = common.length;
  const costChange = base.costPerTaskUsd ? ` (${candidate.costPerTaskUsd >= base.costPerTaskUsd ? '+' : ''}${pct(candidate.costPerTaskUsd / base.costPerTaskUsd - 1)})` : '';
  const costs = `${money(base.costPerTaskUsd)} on version ${base.versionId} to ${money(candidate.costPerTaskUsd)} on version ${candidate.versionId}${costChange}`;
  if (costFirst) {
    reasons.push(
      failures.length
        ? `Rejected: cost per task would go from ${costs}, but ${failures.join(', and ')}.`
        : `Accepted: cost per task goes from ${costs}, no case regressed and the pass rate did not drop.`,
    );
  } else {
    reasons.push(
      failures.length
        ? `Rejected: ${failures.join(', and ')}.`
        : `Accepted: no case regressed, the pass rate did not drop${issueCases.length ? ", and the issue's eval case now passes" : ''}.`,
    );
  }
  const points = n ? Math.round(((candPassed - basePassed) / n) * 100) : 0;
  reasons.push(
    `Pass rate: ${pct(n ? basePassed / n : 0)} (${basePassed} of ${n} cases) on version ${base.versionId}, ${pct(n ? candPassed / n : 0)} (${candPassed} of ${n}) on version ${candidate.versionId} (${points ? `${points > 0 ? '+' : ''}${points} points` : 'no change'}).`,
  );
  if (!costFirst) reasons.push(`Cost per task: ${money(base.costPerTaskUsd)} on version ${base.versionId}, ${money(candidate.costPerTaskUsd)} on version ${candidate.versionId}${costChange}.`);
  if (routing) {
    const score = (c: RoutingCheck['cases'][number]) => `router score ${c.score.toFixed(2)}`;
    for (const c of misrouted) {
      reasons.push(`Misrouted: "${title(c.caseId)}" belongs to a capability issue, but the router sends it to ${routing.easyTier} (${score(c)}).`);
    }
    if (!misrouted.length) {
      reasons.push(
        routing.cases.length
          ? `Routing: all ${routing.cases.length} capability case${routing.cases.length > 1 ? 's go' : ' goes'} to ${routing.hardTier} (${routing.cases.map(score).join(', ')}).`
          : 'Routing: no enabled eval case belongs to a capability issue, so routing was not checked case by case.',
      );
    }
    const { size, toHard } = routing.dataset;
    if (size) {
      reasons.push(
        `Routing share: of the ${size} requests in the router dataset, it sends ${toHard} (${pct(toHard / size)}) to ${routing.hardTier} and the other ${size - toHard} to ${routing.easyTier}.`,
      );
    }
  }
  for (const r of common.filter((r) => r.rule === 'every' && candidate.strictTrials)) {
    reasons.push(strictReason(title(r.caseId), baseBy.get(r.caseId)!, r, base.versionId, candidate.versionId, candidate.strictTrials!));
  }
  for (const r of regressed) {
    reasons.push(`Regressed: "${title(r.caseId)}" passed on version ${base.versionId} and fails on version ${candidate.versionId} (${trials(r)}).${failingDetail(r)}`);
  }
  for (const r of fixed) reasons.push(`Fixed: "${title(r.caseId)}" failed on version ${base.versionId} and passes on version ${candidate.versionId} (${trials(r)}).`);
  if (issueCases.length && !issueFixed.length) {
    for (const r of issueCases) reasons.push(`Still failing: "${title(r.caseId)}" from this issue (${trials(r)}).${failingDetail(r)}`);
  }

  return { decision: failures.length ? 'reject' : 'accept', fixedCaseIds: fixed.map((r) => r.caseId), regressedCaseIds: regressed.map((r) => r.caseId), reasons };
}

export async function gateProposal(h: Healer, proposalId: string, onProgress?: (done: number, total: number) => void): Promise<GateRun> {
  const { store } = h;
  const proposal = store.proposals.get(proposalId);
  if (!proposal) throw new Error(`Unknown proposal ${proposalId}`);
  if (proposal.status !== 'draft') throw new Error(`Proposal ${proposalId} is ${proposal.status}; only a draft can be gated`);
  const gateRun: GateRun = {
    id: newId('gate'),
    createdAt: now(),
    proposalId,
    baseVersionId: proposal.baseVersionId,
    candidateVersionId: proposal.candidateVersionId,
    baseRunId: null,
    candidateRunId: null,
    fixedCaseIds: [],
    regressedCaseIds: [],
    decision: 'pending',
    reasons: [],
  };
  store.gateRuns.put(gateRun);
  store.proposals.put({ ...proposal, status: 'gating', gateRunId: gateRun.id });
  h.changed('gateRun', 'proposal');

  const issue = proposal.issueId ? store.issues.get(proposal.issueId) : null;
  const refusal = issue && preferenceScopeRefusal(issue, proposal.changes, store.versions.get(proposal.baseVersionId)!);
  if (refusal) {
    Object.assign(gateRun, { decision: 'reject', reasons: [refusal] });
  } else {
    // A model change alters how reliably the agent acts, so cases that move money must pass every one of many trials.
    const model = store.versions.get(proposal.candidateVersionId)!.model;
    const strict = JSON.stringify(store.versions.get(proposal.baseVersionId)!.model) !== JSON.stringify(model);
    let baseRun: EvalRun;
    let candidateRun: EvalRun;
    try {
      // The base run usually comes back at once from an earlier run of the live version.
      baseRun = await runSuite(h, proposal.baseVersionId, onProgress, undefined, { strict });
      gateRun.baseRunId = baseRun.id;
      store.gateRuns.put(gateRun);
      candidateRun = await runSuite(h, proposal.candidateVersionId, onProgress, undefined, { strict });
    } catch (err) {
      if (store.proposals.get(proposalId)) store.proposals.put({ ...store.proposals.get(proposalId)!, status: 'draft' });
      throw err;
    }
    gateRun.candidateRunId = candidateRun.id;

    const issueCaseIds = issue ? issue.evalCaseIds.filter((id) => store.evalCases.get(id)?.enabled) : null;
    const costFirst = !issue && proposal.changes.every((c) => c.surface === 'model');
    const routing: RoutingCheck | null =
      model.mode === 'routed'
        ? {
            easyTier: model.easyTier,
            hardTier: model.hardTier,
            cases: store.evalCases
              .list()
              .filter((c) => c.enabled && c.issueId && store.issues.get(c.issueId)?.cause === 'capability')
              .map((c) => ({ caseId: c.id, ...predictRoute(model.router, c.message) })),
            dataset: { size: store.routerDataset().length, toHard: store.routerDataset().filter((e) => predictRoute(model.router, e.text).needsStrong).length },
          }
        : null;
    Object.assign(gateRun, decide(baseRun, candidateRun, issueCaseIds, (id) => store.evalCases.get(id)?.title ?? id, { costFirst, routing }));
  }
  store.gateRuns.put(gateRun);

  const accepted = gateRun.decision === 'accept';
  store.proposals.put({ ...store.proposals.get(proposalId)!, status: accepted ? 'awaiting_approval' : 'rejected' });
  if (!accepted) {
    store.versions.put({ ...store.versions.get(proposal.candidateVersionId)!, status: 'rejected' });
    if (issue && !issue.proposalIds.some((id) => id !== proposalId && isOpenProposal(store.proposals.get(id)!))) {
      store.issues.put({ ...issue, status: 'open', updatedAt: now() });
    }
  }
  h.activity('gate', `${accepted ? 'Accepted' : 'Rejected'} "${proposal.title}": ${gateRun.reasons[0]}`, { kind: 'gateRun', id: gateRun.id, label: gateRun.decision });
  h.changed('gateRun', 'proposal', 'version', 'issue', 'evalRun');
  // A version was promoted while this gate ran, so the acceptance is against a version that is no longer live.
  if (accepted && store.liveVersion()!.id !== proposal.baseVersionId) reproposeOnLive(h, [store.proposals.get(proposalId)!]);
  return gateRun;
}

// Whether every enabled eval case of the gated proposal's issue failed on the candidate.
export function issueCasesStillFail(h: Healer, gateRun: GateRun): boolean {
  const { store } = h;
  const issueId = store.proposals.get(gateRun.proposalId)?.issueId;
  const run = gateRun.candidateRunId ? store.evalRuns.get(gateRun.candidateRunId) : null;
  if (!issueId || !run) return false;
  const caseIds = store.issues.get(issueId)!.evalCaseIds.filter((id) => store.evalCases.get(id)?.enabled);
  const results = run.results.filter((r) => caseIds.includes(r.caseId));
  return results.length > 0 && results.every((r) => !r.passed);
}

// Rebuilds waiting proposals on the live version after a promotion: each becomes a new draft with the same changes,
// and the stale one is discarded. Outside manual mode the new drafts are gated again through the queue. Each stale
// proposal is handled once, and a re-gated draft waits for approval, so a promotion never sets off another.
export function reproposeOnLive(h: Healer, stale: Proposal[]): void {
  const live = h.store.liveVersion()!;
  const gate = h.store.settings().autonomy !== 'manual';
  for (const p of stale) {
    try {
      const next = proposeAgain(h, p, `Proposed again on version ${live.id}, which replaced version ${p.baseVersionId}`);
      discardProposal(h, p, `: replaced by ${next.id} on version ${live.id}`);
      if (gate) startGateJob(h, next.id);
    } catch (err) {
      if (!(err instanceof ChangeError)) throw err;
      discardProposal(h, p, `: it no longer applies to version ${live.id}. ${err.message}`);
    }
  }
}

export function startGateJob(h: Healer, proposalId: string): Job {
  return h.startJob('gate', `Gate proposal ${proposalId}`, proposalId, (job) =>
    h.stage('gate', 'Gate a proposal', async () => {
      await gateProposal(h, proposalId, (done, total) => job.progress(done, total));
    }),
  );
}
