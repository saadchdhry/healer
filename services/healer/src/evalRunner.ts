import { Environment, runAgent, type AgentVersion, type CaseResult, type EvalCase, type EvalRun, type Job, type Trace, type TrialResult } from '@healer/agent';
import { newId, now, type Healer } from './console.ts';
import { evaluateChecks } from './evals.ts';

const CONCURRENCY = 4;
// A trial whose run crashed (an API error, not a wrong answer) is retried so plumbing is not scored as a regression.
const RUN_ATTEMPTS = 3;

export async function runTrial(h: Healer, version: AgentVersion, evalCase: EvalCase): Promise<TrialResult> {
  let trace: Trace;
  let attempt = 0;
  do {
    trace = await runAgent({
      version,
      env: new Environment(evalCase.env),
      customerId: evalCase.customerId,
      history: evalCase.history,
      message: evalCase.message,
      threadId: newId('th_eval'),
      traceId: newId('tr_eval'),
      source: 'eval',
      llm: h.llm(),
    });
    h.recordTraceCost(trace.runs);
    attempt++;
  } while (trace.error && attempt < RUN_ATTEMPTS);
  // Kept so the console can open it, but eval traces are never judged or diagnosed.
  h.store.saveTrace(trace);
  const checks = await evaluateChecks(h, trace, evalCase.checks);
  return { traceId: trace.id, passed: checks.every((c) => c.passed), checks, costUsd: trace.usage.costUsd };
}

export function caseResult(caseId: string, trials: TrialResult[], rule: CaseResult['rule']): CaseResult {
  const passes = trials.filter((t) => t.passed).length;
  return { caseId, trials, passRate: passes / trials.length, rule, passed: rule === 'every' ? passes === trials.length : passes * 2 > trials.length };
}

const ruleFor = (c: EvalCase, strict: boolean): CaseResult['rule'] => (strict && c.strict ? 'every' : 'majority');

function summarise(run: EvalRun): void {
  const trials = run.results.flatMap((r) => r.trials);
  run.passRate = run.results.length ? run.results.filter((r) => r.passed).length / run.results.length : 0;
  run.totalCostUsd = trials.reduce((n, t) => n + t.costUsd, 0);
  run.costPerTaskUsd = trials.length ? run.totalCostUsd / trials.length : 0;
}

export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface TrialPlan {
  key: string;
  version: AgentVersion;
  evalCase: EvalCase;
  rule: CaseResult['rule'];
  trials: number;
}

// Runs each planned case its number of trials, a few trials at a time, and hands over each case's result as soon as its
// trials are done.
export async function runPlans(
  h: Healer,
  epoch: number,
  plans: TrialPlan[],
  onResult: (plan: TrialPlan, result: CaseResult) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const units = plans.flatMap((p) => Array.from({ length: p.trials }, () => p));
  const trials = new Map<string, TrialResult[]>();
  const inFlight = new Map<string, number>();
  // Cases under the every-trial rule with a failed trial: one failure decides the case, so their remaining trials are skipped.
  const stopped = new Set<string>();
  const reported = new Set<string>();
  let done = 0;
  onProgress?.(0, units.length);
  await pool(units, CONCURRENCY, async (plan) => {
    if (stopped.has(plan.key)) {
      onProgress?.(++done, units.length);
      return;
    }
    h.checkEpoch(epoch);
    inFlight.set(plan.key, (inFlight.get(plan.key) ?? 0) + 1);
    const trial = await runTrial(h, plan.version, plan.evalCase);
    h.checkEpoch(epoch);
    inFlight.set(plan.key, inFlight.get(plan.key)! - 1);
    const list = trials.get(plan.key) ?? [];
    list.push(trial);
    trials.set(plan.key, list);
    if (plan.rule === 'every' && !trial.passed) stopped.add(plan.key);
    const finished = list.length === plan.trials || (stopped.has(plan.key) && !inFlight.get(plan.key));
    if (finished && !reported.has(plan.key)) {
      reported.add(plan.key);
      onResult(plan, caseResult(plan.evalCase.id, list, plan.rule));
    }
    onProgress?.(++done, units.length);
  });
}

// For each enabled case, the latest result of this version that still counts: run under the rule the case needs now
// (`strict` asks for the every-trial rule on strict cases), with the current trial count or, under the every-trial rule,
// stopped by a failure, and not older than the last edit to the case's checks. `prior` is the run they all came from,
// when there is one, and `missing` the enabled cases with no such result.
export function reusableRun(h: Healer, versionId: number, strict = false): { prior: EvalRun | null; kept: CaseResult[]; missing: EvalCase[] } {
  const { trialsPerCase, strictTrials } = h.store.settings();
  const enabled = h.store.evalCases.list().filter((c) => c.enabled);
  const edited = h.store.checksEditedAt();
  const runs = h.store.evalRuns.list().filter((r) => r.versionId === versionId && r.status === 'done').reverse();
  const usable = (r: CaseResult, c: EvalCase) =>
    ruleFor(c, strict) === 'every'
      ? r.rule === 'every' && (r.trials.length === strictTrials || r.trials.some((t) => !t.passed))
      : r.rule === 'majority' && r.trials.length === trialsPerCase;
  const kept: CaseResult[] = [];
  const sources = new Set<EvalRun>();
  const missing: EvalCase[] = [];
  for (const c of enabled) {
    const run = runs.find((run) => (edited[c.id] ?? '') < run.startedAt && run.results.some((r) => r.caseId === c.id && usable(r, c)));
    if (!run) {
      missing.push(c);
      continue;
    }
    kept.push(run.results.find((r) => r.caseId === c.id)!);
    sources.add(run);
  }
  return { prior: sources.size === 1 ? [...sources][0]! : null, kept, missing };
}

// Runs the suite over a version. The gate reuses a run that already covers every enabled case, otherwise runs only the
// missing cases and merges them with the earlier results into a new run. A run asked for by hand (`fresh`) runs every case.
// With `strict`, strict cases run `strictTrials` times under the every-trial rule and stop at their first failed trial.
export async function runSuite(
  h: Healer,
  versionId: number,
  onProgress?: (done: number, total: number) => void,
  onRun?: (run: EvalRun) => void,
  { fresh = false, strict = false }: { fresh?: boolean; strict?: boolean } = {},
): Promise<EvalRun> {
  const { store } = h;
  const epoch = h.epoch;
  const version = store.versions.get(versionId);
  if (!version) throw new Error(`Unknown version ${versionId}`);
  const { prior, kept, missing } = fresh ? { prior: null, kept: [], missing: store.evalCases.list().filter((c) => c.enabled) } : reusableRun(h, versionId, strict);
  if (prior && !missing.length) {
    onRun?.(prior);
    return prior;
  }

  const { trialsPerCase, strictTrials } = store.settings();
  const enabled = store.evalCases.list().filter((c) => c.enabled);
  const enabledIds = enabled.map((c) => c.id);
  const run: EvalRun = {
    id: newId('er'),
    versionId,
    status: 'running',
    startedAt: now(),
    endedAt: null,
    trialsPerCase,
    strictTrials: strict && enabled.some((c) => c.strict) ? strictTrials : null,
    results: kept,
    passRate: 0,
    costPerTaskUsd: 0,
    totalCostUsd: 0,
  };
  summarise(run);
  store.evalRuns.put(run);
  onRun?.(run);
  h.changed('evalRun');

  try {
    await runPlans(
      h,
      epoch,
      missing.map((c) => {
        const rule = ruleFor(c, strict);
        return { key: c.id, version, evalCase: c, rule, trials: rule === 'every' ? strictTrials : trialsPerCase };
      }),
      (_, result) => {
        run.results.push(result);
        summarise(run);
        store.evalRuns.put(run);
      },
      onProgress,
    );
  } catch (err) {
    if (h.epoch === epoch) {
      run.status = 'failed';
      run.endedAt = now();
      store.evalRuns.put(run);
      h.changed('evalRun');
    }
    throw err;
  }
  run.results.sort((a, b) => enabledIds.indexOf(a.caseId) - enabledIds.indexOf(b.caseId));
  run.status = 'done';
  run.endedAt = now();
  summarise(run);
  store.evalRuns.put(run);
  h.changed('evalRun', 'evalCase', 'trace');
  return run;
}

export function startEvalJob(h: Healer, versionId: number): Job {
  return h.startJob('eval', `Run the eval suite on version ${versionId}`, null, (job) =>
    h.stage('gate', `Eval suite on version ${versionId}`, async () => {
      const run = await runSuite(
        h,
        versionId,
        (done, total) => job.progress(done, total),
        (r) => job.setRef(r.id),
        { fresh: true },
      );
      h.activity('gate', `Eval suite on version ${versionId}: ${Math.round(run.passRate * 100)}% of ${run.results.length} cases pass`, { kind: 'evalRun', id: run.id, label: `v${versionId}` });
    }),
  );
}

// Latest result per version for one case, oldest version first.
export function caseHistory(h: Healer, caseId: string): { versionId: number; passRate: number; passed: boolean }[] {
  const latest = new Map<number, CaseResult>();
  for (const run of h.store.evalRuns.list()) {
    const result = run.results.find((r) => r.caseId === caseId);
    if (result) latest.set(run.versionId, result);
  }
  return [...latest.entries()].sort(([a], [b]) => a - b).map(([versionId, r]) => ({ versionId, passRate: r.passRate, passed: r.passed }));
}
