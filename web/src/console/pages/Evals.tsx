import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { CheckKind, EvalCase, EvalCheckSpec } from '@healer/agent';
import type { EvalCaseView } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime, ms, pct, usd } from '../../lib/format.ts';
import { useConsole } from '../stream.tsx';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { useCustomers } from '../components/TraceTable.tsx';
import { IdLink, JobProgress, Json, Layer, LineageStrip, PageHead, Tag, VerdictBadge, checkKindWord } from '../components/ui.tsx';
import { CaseComparison, TrialsSetting } from './Gate.tsx';

const explainer =
  'The eval suite is the definition of good. Each case is a realistic input, usually taken from a real failure, plus checks on the final answer, the end state of the shop data, or the sequence of tool calls. Every failure that gets fixed becomes a permanent case, so the suite only grows, and it runs in a sandbox that never touches the live shop.';

const originWord: Record<EvalCase['origin'], string> = { golden: 'Written up front', failure: 'From a failure', redteam: 'From a red team probe', human: 'Added by hand' };
const kinds: CheckKind[] = ['end_state', 'tool_sequence', 'exact_match', 'rubric', 'invariant', 'consistency', 'feedback'];

function HistoryGrid({ views, versionIds }: { views: EvalCaseView[]; versionIds: number[] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="hc-grid">
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0 8px' }}>Case</th>
            <th></th>
            <th></th>
            {versionIds.map((v) => (
              <th key={v}>
                <Link to={`/console/versions/${v}`}>v{v}</Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {views.map(({ case: c, history }) => (
            <tr key={c.id}>
              <td style={{ padding: '0 8px', whiteSpace: 'nowrap' }}>
                <IdLink kind="evalCase" id={c.id} />
              </td>
              <td style={{ padding: '0 8px', fontSize: 13, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.title}>
                {c.title}
                {!c.enabled && <span className="hc-muted"> (disabled)</span>}
                {c.validation?.setAside.length ? <span className="hc-muted"> ({c.validation.setAside.length} {c.validation.setAside.length > 1 ? 'checks' : 'check'} set aside)</span> : null}
              </td>
              <td style={{ padding: '0 8px', whiteSpace: 'nowrap' }}>
                <Tag>{originWord[c.origin]}</Tag> {c.strict && <Tag>strict</Tag>}
              </td>
              {versionIds.map((v) => {
                const h = history.find((x) => x.versionId === v);
                return (
                  <td key={v} className={`cell ${h ? (h.passed ? 'pass' : 'fail') : 'none'}`} title={h ? `v${v}: ${pct(h.passRate)} of trials passed` : `v${v}: not run`}>
                    {h ? (h.passed ? '✓' : '✗') : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvalsPage() {
  const evals = useApi('GET /api/healer/evals', [], ['evalCase', 'evalRun']);
  const versions = useApi('GET /api/healer/versions', [], ['version']);
  const runs = useApi('GET /api/healer/eval-runs', [], ['evalRun']);
  const { overview, jobs, trackJob } = useConsole();
  const [versionId, setVersionId] = useState<string>('');
  const act = useAction();
  const target = versionId || String(overview?.liveVersionId ?? '');
  const running = jobs.filter((j) => j.kind === 'eval' && j.status === 'running');

  return (
    <>
      <PageHead title="Eval suite">{explainer}</PageHead>
      <TrialsSetting />
      <Layer
        title="Cases and pass history"
        aside={
          <span className="hc-row">
            <select className="hc-select" value={target} onChange={(e) => setVersionId(e.target.value)} aria-label="Version to run the suite on">
              {versions.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.id} {v.status}
                </option>
              ))}
            </select>
            <button type="button" className="hc-btn" disabled={act.busy || !target} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/evals/run', { body: { versionId: Number(target) } })))}>
              Run the suite on this version
            </button>
          </span>
        }
      >
        <ActionError error={act.error} />
        {running.map((j) => (
          <div key={j.id} className="hc-panel" style={{ marginBottom: 10 }}>
            <JobProgress job={j} />
          </div>
        ))}
        <Q q={evals} what="eval cases">
          {(list) => {
            const ids = [...new Set(list.flatMap((v) => v.history.map((h) => h.versionId)))].sort((a, b) => a - b);
            return list.length ? (
              <div className="hc-panel">
                <HistoryGrid views={list} versionIds={ids} />
              </div>
            ) : (
              <Empty>No eval cases yet. Cases are added when a failure is fixed, or by hand below.</Empty>
            );
          }}
        </Q>
      </Layer>
      <Layer title="Eval runs">
        <Q q={runs} what="eval runs">
          {(list) =>
            list.length ? (
              <table className="hc-table">
                <thead>
                  <tr>
                    <th>Eval run</th>
                    <th>Version</th>
                    <th>Status</th>
                    <th className="num">Cases</th>
                    <th className="num">Pass rate</th>
                    <th className="num">Cost per task</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <IdLink kind="evalRun" id={r.id} />
                      </td>
                      <td>
                        <IdLink kind="version" id={r.versionId} />
                      </td>
                      <td>{r.status === 'running' ? <VerdictBadge state="pending" label="Running" /> : r.status === 'failed' ? <VerdictBadge state="fail" label="Failed to run" /> : 'Done'}</td>
                      <td className="num">{r.results.length}</td>
                      <td className="num mono">{pct(r.passRate)}</td>
                      <td className="num mono">{usd(r.costPerTaskUsd)}</td>
                      <td className="hc-muted">{dateTime(r.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No eval runs yet. Run the suite on a version above.</Empty>
            )
          }
        </Q>
      </Layer>
      <Layer title="Add a case">
        <CaseEditor />
      </Layer>
    </>
  );
}

function ChecksEditor({ checks, onChange }: { checks: EvalCheckSpec[]; onChange: (c: EvalCheckSpec[]) => void }) {
  const [drafts, setDrafts] = useState<string[]>(checks.map((c) => JSON.stringify(c.params)));
  const [bad, setBad] = useState<number | null>(null);
  const update = (i: number, patch: Partial<EvalCheckSpec>) => onChange(checks.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="hc-stack" style={{ gap: 8 }}>
      {checks.map((c, i) => (
        <div key={c.id} className="hc-row" style={{ alignItems: 'start' }}>
          <select className="hc-select" value={c.kind} onChange={(e) => update(i, { kind: e.target.value as CheckKind })}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {checkKindWord[k]}
              </option>
            ))}
          </select>
          <input className="hc-input" style={{ flex: 1 }} value={c.label} placeholder="What the check asserts" onChange={(e) => update(i, { label: e.target.value })} />
          <input
            className="hc-input mono"
            style={{ flex: 1, borderColor: bad === i ? 'var(--fail)' : undefined }}
            value={drafts[i] ?? '{}'}
            aria-label="Parameters as JSON"
            onChange={(e) => {
              const v = e.target.value;
              setDrafts((d) => d.map((x, j) => (j === i ? v : x)));
              try {
                update(i, { params: JSON.parse(v) as Record<string, unknown> });
                setBad(null);
              } catch {
                setBad(i);
              }
            }}
          />
          <button
            type="button"
            className="hc-btn"
            onClick={() => {
              onChange(checks.filter((_, j) => j !== i));
              setDrafts((d) => d.filter((_, j) => j !== i));
            }}
          >
            Remove
          </button>
        </div>
      ))}
      {bad !== null && <p className="hc-error">Parameters must be valid JSON.</p>}
      <div>
        <button
          type="button"
          className="hc-btn"
          onClick={() => {
            onChange([...checks, { id: `chk_${Date.now().toString(36)}`, kind: 'rubric', label: '', params: {} }]);
            setDrafts((d) => [...d, '{}']);
          }}
        >
          Add a check
        </button>
      </div>
    </div>
  );
}

function CaseEditor() {
  const { list: customers } = useCustomers();
  const [title, setTitle] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [message, setMessage] = useState('');
  const [checks, setChecks] = useState<EvalCheckSpec[]>([]);
  const act = useAction();
  const navigate = useNavigate();
  const cust = customerId || customers[0]?.id || '';
  const ready = title.trim() && cust && message.trim() && checks.length > 0 && checks.every((c) => c.label.trim());
  return (
    <div className="hc-panel hc-stack">
      <div className="hc-cols">
        <label className="hc-field">
          Title
          <input className="hc-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="hc-field">
          Customer
          <select className="hc-select" value={cust} onChange={(e) => setCustomerId(e.target.value)}>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="hc-field">
        Customer message
        <textarea className="hc-textarea" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} style={{ fontFamily: 'inherit' }} />
      </label>
      <div className="hc-field">Checks</div>
      <ChecksEditor checks={checks} onChange={setChecks} />
      <div>
        <button
          type="button"
          className="hc-btn primary"
          disabled={act.busy || !ready}
          onClick={() =>
            act.run(async () => {
              const c = await call('POST /api/healer/evals', { body: { title: title.trim(), customerId: cust, message: message.trim(), checks } });
              navigate(`/console/evals/${c.id}`);
            })
          }
        >
          Add case
        </button>
      </div>
      <ActionError error={act.error} />
    </div>
  );
}

export function EvalCasePage() {
  const { id = '' } = useParams();
  const q = useApi('GET /api/healer/evals/:id', [{ params: { id } }], ['evalCase', 'evalRun']);
  const { name } = useCustomers();
  const { overview } = useConsole();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [checks, setChecks] = useState<EvalCheckSpec[]>([]);
  const act = useAction();

  return (
    <Q q={q} what="the eval case">
      {({ case: c, history, lineage }) => (
        <>
          <PageHead title={c.title} crumb={<><Link to="/console/evals">Eval suite</Link> <span className="mono">{c.id}</span></>}>
            {explainer}
          </PageHead>
          <LineageStrip lineage={lineage} self={{ kind: 'evalCase', id: c.id }} />
          <div className="hc-cols">
            <div className="hc-panel">
              <h3>Case</h3>
              <dl className="hc-kv">
                <dt>Origin</dt>
                <dd>{originWord[c.origin]}</dd>
                <dt>Source trace</dt>
                <dd>{c.sourceTraceId ? <IdLink kind="trace" id={c.sourceTraceId} /> : <span className="hc-muted">none</span>}</dd>
                <dt>Issue</dt>
                <dd>{c.issueId ? <IdLink kind="issue" id={c.issueId} /> : <span className="hc-muted">none</span>}</dd>
                <dt>Customer</dt>
                <dd>{name(c.customerId)}</dd>
                <dt>Added</dt>
                <dd>{dateTime(c.createdAt)}</dd>
                <dt>In the suite</dt>
                <dd>
                  <label className="hc-row">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      disabled={act.busy}
                      onChange={(e) =>
                        act.run(async () => {
                          await call('PATCH /api/healer/evals/:id', { params: { id: c.id }, body: { enabled: e.target.checked } });
                          q.reload();
                        })
                      }
                    />
                    {c.enabled ? 'Enabled, runs in every gate' : 'Disabled, skipped by the gate'}
                  </label>
                </dd>
                <dt>Strict</dt>
                <dd>
                  <label className="hc-row">
                    <input
                      type="checkbox"
                      checked={c.strict}
                      disabled={act.busy}
                      onChange={(e) =>
                        act.run(async () => {
                          await call('PATCH /api/healer/evals/:id', { params: { id: c.id }, body: { strict: e.target.checked } });
                          q.reload();
                        })
                      }
                    />
                    {c.strict
                      ? `Moves money: when a change switches the model, it runs ${overview?.settings.strictTrials ?? 'the strict number of'} times and every trial must pass`
                      : 'Runs like every other case, under the majority rule'}
                  </label>
                </dd>
              </dl>
              <div className="hc-convo" style={{ marginTop: 12 }}>
                {c.history.map((t, i) => (
                  <div key={i} className={`hc-bubble ${t.role}`}>
                    {t.text}
                  </div>
                ))}
                <div className="hc-bubble customer">{c.message}</div>
              </div>
            </div>
            <div className="hc-panel">
              <h3>Pass history</h3>
              {history.length ? (
                <table className="hc-table">
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.versionId}>
                        <td>
                          <IdLink kind="version" id={h.versionId} />
                        </td>
                        <td>
                          <VerdictBadge state={h.passed ? 'pass' : 'fail'} />
                        </td>
                        <td className="num mono">{pct(h.passRate)} of trials</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>No version has run this case yet. It runs in the next gate or suite run.</Empty>
              )}
            </div>
          </div>
          <Layer
            title="Checks"
            aside={
              !editing && (
                <button
                  type="button"
                  className="hc-btn"
                  onClick={() => {
                    setTitle(c.title);
                    setChecks(c.checks);
                    setEditing(true);
                  }}
                >
                  Edit case
                </button>
              )
            }
          >
            {editing ? (
              <div className="hc-panel hc-stack">
                <label className="hc-field">
                  Title
                  <input className="hc-input" value={title} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <ChecksEditor checks={checks} onChange={setChecks} />
                <div className="hc-row">
                  <button
                    type="button"
                    className="hc-btn primary"
                    disabled={act.busy || !title.trim()}
                    onClick={() =>
                      act.run(async () => {
                        const checksChanged = JSON.stringify(checks) !== JSON.stringify(c.checks);
                        await call('PATCH /api/healer/evals/:id', { params: { id: c.id }, body: { title: title.trim(), ...(checksChanged ? { checks } : {}) } });
                        setEditing(false);
                        q.reload();
                      })
                    }
                  >
                    Save
                  </button>
                  <button type="button" className="hc-btn" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <table className="hc-table">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Check</th>
                    <th>Parameters</th>
                  </tr>
                </thead>
                <tbody>
                  {c.checks.map((k) => (
                    <tr key={k.id}>
                      <td>
                        <Tag>{checkKindWord[k.kind]}</Tag>
                      </td>
                      <td>{k.label}</td>
                      <td className="mono hc-sub">{JSON.stringify(k.params)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <ActionError error={act.error} />
          </Layer>
          <ValidationLayer c={c} reload={q.reload} />
          <Layer title="Raw workings" aside="The case exactly as stored, including the shop snapshot it starts from" raw>
            <Json value={c} />
          </Layer>
        </>
      )}
    </Q>
  );
}

const referenceAgent = 'A stronger model that is shown every shop rule. It is used only to test new cases, never deployed.';

const validationWeakness =
  'Two reference runs can miss a check that is too strict only some of the time. A rubric is graded by a model, so a rubric check can be set aside because the grader was wrong, and the reference agent is still a model, so on the hardest requests it can fail a correct check. That is why failing one run in two only flags a check, and why a check set aside stays here and can be put back. The test against shop policy covers only end state checks; tool sequences and rubrics are tested only by the reference runs.';

function ValidationLayer({ c, reload }: { c: EvalCase; reload: () => void }) {
  const { jobs, trackJob } = useConsole();
  const act = useAction();
  const v = c.validation;
  const job = jobs.find((j) => j.kind === 'validate' && j.refId === c.id && j.status === 'running');
  const label = (id: string) => c.checks.find((k) => k.id === id)?.label ?? id;
  return (
    <Layer
      title="Tested before joining the suite"
      aside={
        <button type="button" className="hc-btn" disabled={act.busy || Boolean(job)} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/evals/:id/validate', { params: { id: c.id } })))}>
          Test this case
        </button>
      }
    >
      <ActionError error={act.error} />
      {job && (
        <div className="hc-panel" style={{ marginBottom: 10 }}>
          <JobProgress job={job} />
        </div>
      )}
      {!v ? (
        <Empty>Not tested yet. A case diagnosis writes is tested before it joins the suite; test this one to check it against shop policy, its source trace and the reference agent.</Empty>
      ) : (
        <div className="hc-stack">
          <div className="hc-panel">
            <dl className="hc-kv">
              <dt>Tested</dt>
              <dd>{dateTime(v.at)}</dd>
              <dt>Catches its source failure</dt>
              <dd>
                {v.catchesSource === null ? (
                  <span className="hc-muted">No source trace to test against</span>
                ) : v.catchesSource ? (
                  <>
                    <VerdictBadge state="pass" label="Yes" /> {v.caughtBy.map((id) => `"${label(id)}"`).join(', ')} {v.caughtBy.length > 1 ? 'fail' : 'fails'} on the source trace
                  </>
                ) : (
                  <>
                    <VerdictBadge state="fail" label="No" /> every check it keeps passes on the source trace
                  </>
                )}
              </dd>
              <dt>Reference agent</dt>
              <dd>
                {v.referenceTier}. <span className="hc-muted">{referenceAgent}</span>
              </dd>
              <dt>Reference runs</dt>
              <dd className="hc-row">
                {v.referenceTraceIds.map((id) => (
                  <IdLink key={id} kind="trace" id={id} />
                ))}
              </dd>
            </dl>
          </div>
          <div className="hc-panel">
            <h3>Set aside</h3>
            {v.setAside.length ? (
              <table className="hc-table">
                <tbody>
                  {v.setAside.map((s, i) => (
                    <tr key={s.check.id}>
                      <td>
                        <Tag>{checkKindWord[s.check.kind]}</Tag>
                      </td>
                      <td>
                        {s.check.label}
                        <div className="hc-sub">{s.reason}</div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="hc-btn"
                          disabled={act.busy}
                          onClick={() =>
                            act.run(async () => {
                              await call('PATCH /api/healer/evals/:id', {
                                params: { id: c.id },
                                body: { checks: [...c.checks, s.check], validation: { ...v, setAside: v.setAside.filter((_, j) => j !== i) } },
                              });
                              reload();
                            })
                          }
                        >
                          Put back
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="hc-muted">No check was set aside.</p>
            )}
            <h3>Flagged</h3>
            {v.flagged.length ? (
              <ul>
                {v.flagged.map((f) => (
                  <li key={f.checkId}>
                    {label(f.checkId)}: <span className="hc-muted">{f.reason} It stays in the case.</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hc-muted">No check was flagged.</p>
            )}
          </div>
        </div>
      )}
      <p className="hc-muted">{validationWeakness}</p>
    </Layer>
  );
}

export function EvalRunPage() {
  const { id = '' } = useParams();
  const q = useApi('GET /api/healer/eval-runs/:id', [{ params: { id } }], ['evalRun']);
  return (
    <Q q={q} what="the eval run">
      {(r) => (
        <>
          <PageHead title={<>Eval run <span className="mono">{r.id}</span></>} crumb={<Link to="/console/evals">Eval suite</Link>}>
            {explainer}
          </PageHead>
          <div className="hc-cols-3">
            <div className="hc-panel hc-figure">
              <span>Version</span>
              <b>
                <IdLink kind="version" id={r.versionId} />
              </b>
              <span>{r.status === 'running' ? 'Still running' : `Took ${ms(r.startedAt, r.endedAt)}`}</span>
            </div>
            <div className="hc-panel hc-figure">
              <span>Pass rate</span>
              <b>{pct(r.passRate)}</b>
              <span>
                {r.results.filter((x) => x.passed).length} of {r.results.length} cases, {r.trialsPerCase} trials each{r.strictTrials !== null && `, ${r.strictTrials} for strict cases`}
              </span>
            </div>
            <div className="hc-panel hc-figure">
              <span>Cost per task</span>
              <b>{usd(r.costPerTaskUsd)}</b>
              <span>{usd(r.totalCostUsd)} for the whole run</span>
            </div>
          </div>
          <Layer title="Per case" aside="Each square is one trial; click it for its trace">
            <CaseComparison base={null} candidate={r} />
          </Layer>
          <Layer title="Raw workings" raw>
            <Json value={r} />
          </Layer>
        </>
      )}
    </Q>
  );
}
