import { END, Graph, type Autonomy, type GateRun, type Verdict } from '@healer/agent';
import { StaleWorkError, type Healer } from './console.ts';
import { diagnoseTrace } from './diagnose.ts';
import { gateProposal } from './gate.ts';
import { judgeTrace } from './judge.ts';
import { approve } from './promote.ts';
import { isOpenProposal, proposeForIssue } from './propose.ts';

// The improvement loop, defined on the same Graph runner as the agent. GET /graphs draws this shape,
// and runLoop below is the only thing that runs the loop automatically.

interface LoopState {
  h: Healer;
  epoch: number;
  traceId: string;
  autonomy: Autonomy;
  verdict: Verdict | null;
  // Issues waiting for a proposal, worked one at a time.
  pending: string[];
  proposalId: string | null;
  gateRun: GateRun | null;
  // Proposals made for the issue at the head of `pending`.
  attempts: number;
  afterGate: 'promote' | 'retry' | 'next';
}

// One first attempt and at most two automatic retries after a rejection.
export const MAX_ATTEMPTS = 3;

function needsProposal(h: Healer, issueId: string): boolean {
  const issue = h.store.issues.get(issueId)!;
  return issue.status === 'open' && !issue.proposalIds.some((id) => isOpenProposal(h.store.proposals.get(id)!));
}

function nextIssue(s: LoopState): void {
  s.pending.shift();
  s.attempts = 0;
  s.proposalId = null;
  s.gateRun = null;
}

export const loopGraph = new Graph<LoopState>('improvement_loop', 'judge')
  .node('judge', 'Judge', 'Check the trace against every shop policy rule in code, and ask the judge model whether the reply is truthful and grounded. Customer preferences become issues.', async (s) => {
    s.h.checkEpoch(s.epoch);
    const trace = s.h.store.trace(s.traceId)!;
    const { verdict, preferenceIssues } = await s.h.stage('judge', 'Judge a trace', () => judgeTrace(s.h, trace));
    s.verdict = verdict;
    if (s.autonomy !== 'manual') s.pending.push(...preferenceIssues.map((i) => i.id));
    return { passed: verdict.passed, failed: verdict.checks.filter((c) => !c.passed).map((c) => c.checkId), preferences: preferenceIssues.length };
  })
  .node('diagnose', 'Diagnose', 'Name the cause of the failure (knowledge, process or capability), file it under an issue, and write an eval case for it.', async (s) => {
    s.h.checkEpoch(s.epoch);
    const { issue, evalCase, opened } = await s.h.stage('diagnose', 'Diagnose a failure', () => diagnoseTrace(s.h, s.traceId));
    if (needsProposal(s.h, issue.id) && !s.pending.includes(issue.id)) s.pending.push(issue.id);
    return { issueId: issue.id, opened, evalCaseId: evalCase.id };
  })
  .node('propose', 'Propose', "Write the smallest change to the issue's surface (context, harness or model) and build a candidate version.", async (s) => {
    s.h.checkEpoch(s.epoch);
    const issueId = s.pending[0]!;
    const proposal = await s.h.stage('propose', 'Propose a fix', () => proposeForIssue(s.h, issueId));
    s.proposalId = proposal.id;
    s.attempts++;
    return { issueId, proposalId: proposal.id, attempt: s.attempts };
  })
  .node('gate', 'Gate', 'Run the whole eval suite on the live version and the candidate, and accept only if nothing regressed and the issue is fixed.', async (s) => {
    s.h.checkEpoch(s.epoch);
    const id = s.proposalId!;
    s.gateRun = await s.h.stage('gate', 'Gate a proposal', () =>
      s.h.trackJob('gate', `Gate proposal ${id}`, id, (job) => gateProposal(s.h, id, (done, total) => job.progress(done, total))),
    );
    const issue = s.h.store.issues.get(s.pending[0]!)!;
    if (s.gateRun.decision === 'accept') {
      s.afterGate = s.autonomy === 'auto' ? 'promote' : 'next';
    } else {
      s.afterGate = s.attempts < MAX_ATTEMPTS && issue.surface !== 'model' && needsProposal(s.h, issue.id) ? 'retry' : 'next';
    }
    const decision = s.gateRun.decision;
    if (s.afterGate === 'next') nextIssue(s);
    return { decision, then: s.afterGate };
  })
  .node('promote', 'Promote', 'Make the accepted candidate the live version and deploy it to the shop.', async (s) => {
    s.h.checkEpoch(s.epoch);
    const version = await s.h.stage('promote', 'Promote a version', () => approve(s.h, s.proposalId!));
    nextIssue(s);
    return { liveVersionId: version.id };
  })
  .branch(
    'judge',
    [
      { to: 'diagnose', label: 'failed' },
      { to: 'propose', label: 'preference noted' },
      { to: END, label: 'passed, or manual' },
    ],
    (s) => {
      if (s.autonomy === 'manual') return END;
      const filed = s.h.store.issues.list().some((i) => i.traceIds.includes(s.traceId));
      const crashed = s.verdict!.checks.some((c) => c.checkId === 'run_error');
      if (!s.verdict!.passed && !filed && !crashed) return 'diagnose';
      return s.pending.length ? 'propose' : END;
    },
  )
  .branch(
    'diagnose',
    [
      { to: 'propose', label: 'issue needs a fix' },
      { to: END, label: 'fix already pending' },
    ],
    (s) => (s.pending.length ? 'propose' : END),
  )
  .edge('propose', 'gate')
  .branch(
    'gate',
    [
      { to: 'promote', label: 'accepted, auto' },
      { to: 'propose', label: 'rejected and retrying, or next issue' },
      { to: END, label: 'awaiting approval, or out of retries' },
    ],
    (s) => (s.afterGate === 'promote' ? 'promote' : s.afterGate === 'retry' || s.pending.length ? 'propose' : END),
  )
  .branch(
    'promote',
    [
      { to: 'propose', label: 'more issues' },
      { to: END, label: 'done' },
    ],
    (s) => (s.pending.length ? 'propose' : END),
  );

export const loopGraphShape = loopGraph.shape();

// Queues one pass of the loop for a trace. Passes run one at a time.
export function runLoop(h: Healer, traceId: string): Promise<void> {
  return h
    .enqueue(async () => {
      const state: LoopState = {
        h,
        epoch: h.epoch,
        traceId,
        autonomy: h.store.settings().autonomy,
        verdict: null,
        pending: [],
        proposalId: null,
        gateRun: null,
        attempts: 0,
        afterGate: 'next',
      };
      await loopGraph.run(state, { maxSteps: 40 });
    })
    .catch((err: unknown) => {
      if (err instanceof StaleWorkError) return;
      h.activity('run', `The loop stopped on trace ${traceId}: ${err instanceof Error ? err.message : String(err)}`, { kind: 'trace', id: traceId, label: traceId });
    });
}
