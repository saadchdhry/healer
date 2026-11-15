import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CaseResult, EvalRun, GateRun } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { useConsole } from '../stream.tsx';
import { dateTime, ms, pct, usd } from '../../lib/format.ts';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { IdLink, Json, Layer, LineageStrip, PageHead, Tag, VerdictBadge } from '../components/ui.tsx';

const explainer =
  'How do we know it is better? The candidate version runs the whole eval suite in a sandbox whose shop data resets for every case, and each case runs several times because model output varies. A change is kept only if it fixes something and every case that passed before still passes. This is the ratchet.';

export function Decision({ g }: { g: GateRun }) {
  if (g.decision === 'pending') return <VerdictBadge state="pending" label="Running" />;
  return <VerdictBadge state={g.decision === 'accept' ? 'pass' : 'fail'} label={g.decision === 'accept' ? 'Accepted' : 'Rejected'} />;
}

const caught = (trials: number, oneIn: number) => Math.round((1 - (1 - 1 / oneIn) ** trials) * 100);

export function TrialsSetting() {
  const { overview, refreshOverview } = useConsole();
  const current = overview?.settings;
  const [value, setValue] = useState('');
  const [strictValue, setStrictValue] = useState('');
  const act = useAction();
  useEffect(() => {
    if (current) {
      setValue(String(current.trialsPerCase));
      setStrictValue(String(current.strictTrials));
    }
  }, [current?.trialsPerCase, current?.strictTrials]);
  const n = Number(value);
  const strict = Number(strictValue);
  const valid = Number.isInteger(n) && n >= 1 && n <= 9 && Number.isInteger(strict) && strict >= 3 && strict <= 20;
  const changed = n !== current?.trialsPerCase || strict !== current?.strictTrials;
  return (
    <div className="hc-panel">
      <form
        className="hc-stack"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid)
            void act.run(async () => {
              await call('PUT /api/healer/settings', { body: { trialsPerCase: n, strictTrials: strict } });
              refreshOverview();
            });
        }}
      >
        <div className="hc-row">
          <label className="hc-row" style={{ fontSize: 13 }}>
            Trials per eval case
            <input className="hc-input" type="number" min={1} max={9} value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 64 }} />
          </label>
          <span className="hc-muted" style={{ fontSize: 12.5, flex: 1, minWidth: 200 }}>
            More trials separate a real change from run-to-run noise, and each one costs a model call per case. A case passes when most of its trials pass.
          </span>
        </div>
        <div className="hc-row">
          <label className="hc-row" style={{ fontSize: 13 }}>
            Trials per strict case
            <input className="hc-input" type="number" min={3} max={20} value={strictValue} onChange={(e) => setStrictValue(e.target.value)} style={{ width: 64 }} />
          </label>
          <span className="hc-muted" style={{ fontSize: 12.5, flex: 1, minWidth: 200 }}>
            {Number.isInteger(strict) && strict >= 3 && strict <= 20
              ? `With ${strict} trials, a request that fails 1 time in 5 is caught ${caught(strict, 5)}% of the time. `
              : 'Between 3 and 20. '}
            Used only for cases that move money, and only when a change switches the model. Every trial must pass, and the case stops at its first failure.
          </span>
        </div>
        <div>
          <button type="submit" className="hc-btn" disabled={act.busy || !valid || !changed}>
            Save
          </button>
        </div>
      </form>
      <ActionError error={act.error} />
    </div>
  );
}

function StrictWeakness() {
  const n = useConsole().overview?.settings.strictTrials;
  if (n === undefined) return null;
  return (
    <p className="hc-muted" style={{ fontSize: 12.5 }}>
      What strict cases cannot do: {n} trials still miss a request that fails 1 time in 5 about {100 - caught(n, 5)}% of the time, and the rarer error measured during the build, about 1 time in 17 on three
      orders in one message, is caught only {caught(n, 17)}% of the time. A gate cannot prove a rare failure absent; it can only make it unlikely at a stated cost. A strict case that already fails on the
      base counts as failing there and cannot regress, so the gate cannot use it, and its reasons say so. Gates for context and harness changes still use the majority rule, so a prompt change that makes
      refunds flaky can slip through.
    </p>
  );
}

export function GatePage() {
  const runs = useApi('GET /api/healer/gate-runs', [], ['gateRun']);
  return (
    <>
      <PageHead title="Gate">{explainer}</PageHead>
      <TrialsSetting />
      <StrictWeakness />
      <Layer title="Gate runs">
        <Q q={runs} what="gate runs">
          {(list) =>
            list.length ? (
              <table className="hc-table">
                <thead>
                  <tr>
                    <th>Gate run</th>
                    <th>Proposal</th>
                    <th>Versions</th>
                    <th>Decision</th>
                    <th className="num">Fixed</th>
                    <th className="num">Regressed</th>
                    <th>Main reason</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <IdLink kind="gateRun" id={g.id} />
                      </td>
                      <td>
                        <IdLink kind="proposal" id={g.proposalId} />
                      </td>
                      <td>
                        <IdLink kind="version" id={g.baseVersionId} /> against <IdLink kind="version" id={g.candidateVersionId} />
                      </td>
                      <td>
                        <Decision g={g} />
                      </td>
                      <td className="num">{g.fixedCaseIds.length}</td>
                      <td className="num" style={g.regressedCaseIds.length ? { color: 'var(--fail)' } : undefined}>
                        {g.regressedCaseIds.length}
                      </td>
                      <td className="clip hc-sub" style={{ maxWidth: 240 }} title={g.reasons[0]}>{g.reasons[0] ?? ''}</td>
                      <td className="hc-muted">{dateTime(g.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No gate runs yet. Open a proposal and run the gate, or let the loop do it when autonomy is set to approve or automatic.</Empty>
            )
          }
        </Q>
      </Layer>
    </>
  );
}

function Trials({ r, strictTrials }: { r: CaseResult | undefined; strictTrials: number | null }) {
  if (!r) return <span className="hc-muted">not run</span>;
  const skipped = r.rule === 'every' && strictTrials ? strictTrials - r.trials.length : 0;
  return (
    <span className="hc-row" style={{ gap: 8 }}>
      <span className="hc-trials">
        {r.trials.map((t, i) => (
          <Link key={i} to={`/console/traces/${t.traceId}`} className={t.passed ? 'pass' : 'fail'} title={`Trial ${i + 1}: ${t.passed ? 'passed' : 'failed'}, ${usd(t.costUsd)}. Open trace ${t.traceId}`} aria-label={`Trial ${i + 1} ${t.passed ? 'passed' : 'failed'}`} />
        ))}
        {Array.from({ length: skipped }, (_, i) => (
          <span key={`skip${i}`} className="skipped" title="Skipped: a failed trial already decided the case" />
        ))}
      </span>
      <span className="mono">{pct(r.passRate)}</span>
      <VerdictBadge state={r.passed ? 'pass' : 'fail'} label="" />
      {r.rule === 'every' && <span className="hc-muted" style={{ fontSize: 12 }}>{skipped ? `every trial must pass; stopped at the first failure, ${skipped} skipped` : 'every trial must pass'}</span>}
    </span>
  );
}

export function CaseComparison({ base, candidate, fixed = [], regressed = [] }: { base: EvalRun | null; candidate: EvalRun | null; fixed?: string[]; regressed?: string[] }) {
  const evals = useApi('GET /api/healer/evals', [], ['evalCase']);
  const evalCase = (id: string) => evals.data?.find((e) => e.case.id === id)?.case;
  const ids = [...new Set([...(base?.results ?? []), ...(candidate?.results ?? [])].map((r) => r.caseId))];
  if (!ids.length) return <Empty>No case results yet.</Empty>;
  return (
    <table className="hc-table">
      <thead>
        <tr>
          <th>Case</th>
          <th></th>
          {base && <th>Base, v{base.versionId}</th>}
          {candidate && <th>{base ? 'Candidate, ' : 'Result on '}v{candidate.versionId}</th>}
          {base && <th>Change</th>}
        </tr>
      </thead>
      <tbody>
        {ids.map((id) => {
          const isFixed = fixed.includes(id);
          const isReg = regressed.includes(id);
          return (
            <tr key={id} className={`hc-case-row${isFixed ? ' fixed' : isReg ? ' regressed' : ''}`}>
              <td>
                <IdLink kind="evalCase" id={id} />
              </td>
              <td className="hc-sub">
                {evalCase(id)?.title ?? ''} {evalCase(id)?.strict && <Tag>strict</Tag>}
              </td>
              {base && (
                <td>
                  <Trials r={base.results.find((r) => r.caseId === id)} strictTrials={base.strictTrials} />
                </td>
              )}
              {candidate && (
                <td>
                  <Trials r={candidate.results.find((r) => r.caseId === id)} strictTrials={candidate.strictTrials} />
                </td>
              )}
              {base && <td>{isFixed ? <VerdictBadge state="pass" label="Fixed" /> : isReg ? <VerdictBadge state="fail" label="Regressed" /> : <span className="hc-muted">no change</span>}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Figure({ label, before, after, fmt, betterWhen }: { label: string; before: number | undefined; after: number | undefined; fmt: (n: number) => string; betterWhen: 'up' | 'down' }) {
  const delta = before !== undefined && after !== undefined ? after - before : null;
  const good = delta === null || delta === 0 ? null : betterWhen === 'up' ? delta > 0 : delta < 0;
  return (
    <div className="hc-panel hc-figure">
      <span>{label}</span>
      <b>
        {before !== undefined ? fmt(before) : 'none'} <span style={{ color: 'var(--ink-3)', fontSize: 16 }}>to</span> {after !== undefined ? fmt(after) : 'pending'}
      </b>
      {good !== null && <span style={{ color: good ? 'var(--pass)' : 'var(--fail)' }}>{good ? 'Better' : 'Worse'}</span>}
    </div>
  );
}

export function GateRunPage() {
  const { id = '' } = useParams();
  const q = useApi('GET /api/healer/gate-runs/:id', [{ params: { id } }], ['gateRun', 'evalRun']);
  return (
    <Q q={q} what="the gate run">
      {({ gateRun: g, baseRun, candidateRun, lineage }) => (
        <>
          <PageHead title={<>Gate run <span className="mono">{g.id}</span></>} crumb={<Link to="/console/gate">Gate</Link>}>
            {explainer}
          </PageHead>
          <LineageStrip lineage={lineage} self={{ kind: 'gateRun', id: g.id }} />
          <div className="hc-cols-3">
            <div className="hc-panel hc-figure">
              <span>Decision</span>
              <b style={{ fontSize: 18 }}>
                <Decision g={g} />
              </b>
              <span>
                <IdLink kind="version" id={g.candidateVersionId} /> against <IdLink kind="version" id={g.baseVersionId} />, for <IdLink kind="proposal" id={g.proposalId} />
              </span>
            </div>
            <Figure label="Pass rate" before={baseRun?.passRate} after={candidateRun?.status === 'done' ? candidateRun.passRate : undefined} fmt={(n) => pct(n)} betterWhen="up" />
            <Figure label="Cost per task" before={baseRun?.costPerTaskUsd} after={candidateRun?.status === 'done' ? candidateRun.costPerTaskUsd : undefined} fmt={usd} betterWhen="down" />
          </div>
          <Layer title="Reasons">
            {g.reasons.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {g.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : (
              <Empty>The gate is still running. Reasons appear when it decides.</Empty>
            )}
          </Layer>
          <Layer title="Per case" aside="Each square is one trial; click it for its trace. A case passes when most trials pass; a strict case run under the every-trial rule passes only when every trial passes">
            <CaseComparison base={baseRun} candidate={candidateRun} fixed={g.fixedCaseIds} regressed={g.regressedCaseIds} />
          </Layer>
          <Layer title="Raw workings" raw>
            {[baseRun, candidateRun].map(
              (r, i) =>
                r && (
                  <details key={r.id} className="hc-raw">
                    <summary>
                      <strong>{i === 0 ? 'Base eval run' : 'Candidate eval run'}</strong>
                      <IdLink kind="evalRun" id={r.id} />
                      <span className="meta">v{r.versionId}</span>
                      <span className="meta">{r.trialsPerCase} trials per case</span>
                      {r.strictTrials !== null && <span className="meta">{r.strictTrials} per strict case</span>}
                      <span className="meta">{ms(r.startedAt, r.endedAt)}</span>
                      <span className="meta">{usd(r.totalCostUsd)} in all</span>
                    </summary>
                    <div style={{ padding: '0 12px 12px' }}>
                      <Json value={r} />
                    </div>
                  </details>
                ),
            )}
            <details className="hc-raw">
              <summary>
                <strong>Gate record</strong>
                <span className="meta">exact JSON</span>
              </summary>
              <div style={{ padding: '0 12px 12px' }}>
                <Json value={g} />
              </div>
            </details>
          </Layer>
        </>
      )}
    </Q>
  );
}
