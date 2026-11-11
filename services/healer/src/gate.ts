import type { CaseResult, EvalRun, GateRun, Job } from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import { runSuite } from './evalRunner.ts';
import { isOpenProposal } from './propose.ts';

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

// Accept only if no case regressed, the pass rate did not drop, and (for a proposal fixing an issue)
// at least one of that issue's eval cases passes on the candidate. A change made only to save money
// (`costFirst`) is judged the same way, but its reasons lead with what it does to cost per task.
export function decide(
  base: EvalRun,
  candidate: EvalRun,
  issueCaseIds: string[] | null,
  title: (caseId: string) => string,
  { costFirst = false } = {},
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

  let baseRun: EvalRun;
  let candidateRun: EvalRun;
  try {
    // The base run usually comes back at once from an earlier run of the live version.
    baseRun = await runSuite(h, proposal.baseVersionId, onProgress);
    gateRun.baseRunId = baseRun.id;
    store.gateRuns.put(gateRun);
    candidateRun = await runSuite(h, proposal.candidateVersionId, onProgress);
  } catch (err) {
    if (store.proposals.get(proposalId)) store.proposals.put({ ...store.proposals.get(proposalId)!, status: 'draft' });
    throw err;
  }
  gateRun.candidateRunId = candidateRun.id;

  const issue = proposal.issueId ? store.issues.get(proposal.issueId) : null;
  const issueCaseIds = issue ? issue.evalCaseIds.filter((id) => store.evalCases.get(id)?.enabled) : null;
  const costFirst = !issue && proposal.changes.every((c) => c.surface === 'model');
  const result = decide(baseRun, candidateRun, issueCaseIds, (id) => store.evalCases.get(id)?.title ?? id, { costFirst });
  Object.assign(gateRun, result);
  store.gateRuns.put(gateRun);

  const accepted = result.decision === 'accept';
  store.proposals.put({ ...store.proposals.get(proposalId)!, status: accepted ? 'awaiting_approval' : 'rejected' });
  if (!accepted) {
    store.versions.put({ ...store.versions.get(proposal.candidateVersionId)!, status: 'rejected' });
    if (issue && !issue.proposalIds.some((id) => id !== proposalId && isOpenProposal(store.proposals.get(id)!))) {
      store.issues.put({ ...issue, status: 'open', updatedAt: now() });
    }
  }
  h.activity('gate', `${accepted ? 'Accepted' : 'Rejected'} "${proposal.title}": ${result.reasons[0]}`, { kind: 'gateRun', id: gateRun.id, label: result.decision });
  h.changed('gateRun', 'proposal', 'version', 'issue', 'evalRun');
  return gateRun;
}

export function startGateJob(h: Healer, proposalId: string): Job {
  return h.startJob('gate', `Gate proposal ${proposalId}`, proposalId, (job) =>
    h.stage('gate', 'Gate a proposal', async () => {
      await gateProposal(h, proposalId, (done, total) => job.progress(done, total));
    }),
  );
}
