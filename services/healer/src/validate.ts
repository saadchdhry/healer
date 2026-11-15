import type { AgentVersion, CaseValidation, EvalCase, Job, MemoryNote, Trace, TrialResult } from '@healer/agent';
import { now, type Healer } from './console.ts';
import { runTrial } from './evalRunner.ts';
import { checkConflicts, evaluateChecks } from './evals.ts';
import { POLICY_RULES } from './policy.ts';
import { hardTierFor, passesPolicy } from './routerTraining.ts';

// Testing a new eval case before the gate trusts it: does it conflict with policy, does it catch the failure it came
// from, and can an agent that does the right thing pass it.

export const REFERENCE_TRIALS = 2;
export const REFERENCE_NOTE_ID = 'reference_rules';

// The live version plus one shop note listing every policy rule, on the hard tier. It exists only in memory, for the
// length of one test: the agent under test learns the rules only from failed checks, so this note must never reach a
// stored or deployed version, a proposal, or the proposer.
export function referenceVersion(live: AgentVersion): AgentVersion {
  const note: MemoryNote = {
    id: REFERENCE_NOTE_ID,
    scope: { kind: 'shop' },
    text: `Shop rules you must always follow: ${POLICY_RULES.map((r) => `${r.label}. ${r.description}`).join(' ')}`,
    addedInVersion: live.id,
    issueId: null,
  };
  return { ...live, context: [...live.context, note], model: { mode: 'fixed', tier: hardTierFor(live), effort: live.model.effort } };
}

const quote = (s: string) => s.replace(/\.$/, '');

// Returns the case with failing checks moved into its validation record. Checks set aside by an earlier test stay
// set aside. Policy invariants are never set aside.
export async function validateCase(h: Healer, evalCase: EvalCase, sourceTrace: Trace | null): Promise<EvalCase> {
  const epoch = h.epoch;
  const say = (text: string) => h.activity('diagnose', text, { kind: 'evalCase', id: evalCase.id, label: evalCase.title });
  const named = `'${evalCase.title}'`;
  const setAside: CaseValidation['setAside'] = [...(evalCase.validation?.setAside ?? [])];
  const flagged: CaseValidation['flagged'] = [];
  const aside = new Set<string>();
  const putAside = (check: EvalCase['checks'][number], reason: string) => {
    setAside.push({ check, reason });
    aside.add(check.id);
    say(`Set aside a check from ${named}: "${check.label}" ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`);
  };

  for (const check of evalCase.checks) {
    const conflict = checkConflicts(check, evalCase.env, evalCase.customerId);
    if (conflict) putAside(check, `Conflicts with shop policy: ${conflict}`);
  }
  const tested = evalCase.checks.filter((c) => !aside.has(c.id));

  const source = sourceTrace ? await evaluateChecks(h, sourceTrace, tested) : null;

  const version = referenceVersion(h.store.liveVersion()!);
  const tier = hardTierFor(h.store.liveVersion()!);
  const trials: TrialResult[] = [];
  for (let i = 0; i < REFERENCE_TRIALS; i++) {
    h.checkEpoch(epoch);
    trials.push(await runTrial(h, version, { ...evalCase, checks: tested }));
  }
  h.checkEpoch(epoch);
  const counting = trials.filter((t) => passesPolicy(h.store.trace(t.traceId)!));
  for (const check of tested.filter((c) => c.kind !== 'invariant')) {
    const failed = counting.map((t) => t.checks.find((r) => r.checkId === check.id)!).filter((r) => !r.passed);
    if (!failed.length) continue;
    const detail = quote(failed[0]!.detail);
    if (failed.length === counting.length) {
      putAside(check, `Failed on ${counting.length === REFERENCE_TRIALS ? 'both reference runs' : 'the only reference run that kept every policy rule'} (${detail}).`);
    } else {
      const reason = `Failed on one of the ${counting.length} reference runs (${detail}).`;
      flagged.push({ checkId: check.id, reason });
      say(`Flagged a check from ${named}: "${check.label}" ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`);
    }
  }
  const allPassed = counting.length > 0 && counting.every((t) => t.passed);
  say(
    counting.length
      ? `Tested ${named} on the reference agent (${tier}, shown every shop rule): ${counting.length} of ${REFERENCE_TRIALS} runs kept every policy rule${allPassed ? ' and passed every check' : ''}`
      : `Tested ${named} on the reference agent (${tier}, shown every shop rule): neither run kept every policy rule, so the runs set aside no check`,
  );

  const caughtBy = (source ?? []).filter((r) => !r.passed && !aside.has(r.checkId)).map((r) => r.checkId);
  const catchesSource = source ? caughtBy.length > 0 : null;
  if (source) {
    const labels = caughtBy.map((id) => `"${evalCase.checks.find((c) => c.id === id)!.label}"`).join(', ');
    say(catchesSource ? `${named} catches the failure it came from: ${labels} ${caughtBy.length > 1 ? 'fail' : 'fails'} on the source trace` : `${named} does not catch the failure it came from: every check it keeps passes on the source trace`);
  }

  return {
    ...evalCase,
    checks: evalCase.checks.filter((c) => !aside.has(c.id)),
    validation: { at: now(), referenceTier: tier, referenceTraceIds: trials.map((t) => t.traceId), catchesSource, caughtBy, setAside, flagged },
  };
}

export function startValidateJob(h: Healer, caseId: string): Job {
  return h.startJob('validate', `Test eval case ${caseId}`, caseId, (job) =>
    h.stage('diagnose', 'Test an eval case', async () => {
      const current = h.store.evalCases.get(caseId)!;
      const source = current.sourceTraceId ? (h.store.trace(current.sourceTraceId) ?? null) : null;
      const tested = await validateCase(h, current, source);
      h.store.evalCases.put(tested);
      if (tested.checks.length !== current.checks.length) h.store.markChecksEdited(caseId, now());
      job.progress(1, 1);
      h.changed('evalCase', 'trace');
    }),
  );
}
