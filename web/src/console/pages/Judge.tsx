import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import type { RedTeamFinding, Verdict } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime } from '../../lib/format.ts';
import { ApiError } from '../../lib/api.ts';
import { ActionError, Empty, Failed, Loading, Q } from '../components/States.tsx';
import { useCustomers } from '../components/TraceTable.tsx';
import { CheckList, IdLink, Layer, PageHead, RawRun, Tag, VerdictBadge, checkKindWord } from '../components/ui.tsx';

export function JudgePage() {
  const [filter, setFilter] = useState<'' | 'true' | 'false'>('');
  const rules = useApi('GET /api/healer/rules', []);
  const verdicts = useApi('GET /api/healer/verdicts', [{ query: { passed: filter === '' ? undefined : filter === 'true', limit: 200 } }], ['verdict']);
  const findings = useApi('GET /api/healer/findings', [], ['finding']);
  const [traceId, setTraceId] = useState('');
  const [result, setResult] = useState<Verdict | null>(null);
  const act = useAction();

  const latestJudgeRun = verdicts.data?.find((v) => v.judgeRun)?.judgeRun;

  return (
    <>
      <PageHead title="Judge">
        Was the reply good? Checks that can be done in code run first: policy rules, the end state of the shop's data, and the order of tool calls. A model judge is
        used only where judgement is needed, and customer ratings count as feedback. The judge is a model too, so it can be wrong.
      </PageHead>

      <Layer title="Policy rules" aside="The PRD the agent is never shown">
        <Q q={rules} what="rules">
          {(list) =>
            list.length ? (
              <table className="hc-table">
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="mono hc-muted" style={{ width: 200 }}>
                        {r.id}
                      </td>
                      <td style={{ width: 280 }}>{r.label}</td>
                      <td className="hc-sub">{r.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No policy rules are defined in the healer.</Empty>
            )
          }
        </Q>
        <p className="hc-sub" style={{ margin: '10px 0 0' }}>
          Refunds that are too small, or never made, are checked against what the customer asked for: a model reads the request, and code works out what was owed.
        </p>
      </Layer>

      <Layer
        title="Verdicts"
        aside={
          <span className="hc-seg">
            {(
              [
                ['', 'All'],
                ['false', 'Failed'],
                ['true', 'Passed'],
              ] as const
            ).map(([v, l]) => (
              <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>
                {l}
              </button>
            ))}
          </span>
        }
      >
        <Q q={verdicts} what="verdicts">
          {(list) =>
            list.length ? (
              <table className="hc-table">
                <thead>
                  <tr>
                    <th>Verdict</th>
                    <th>Trace</th>
                    <th>Result</th>
                    <th>Checks that failed</th>
                    <th>Judged</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((v) => {
                    const failed = v.checks.filter((c) => !c.passed);
                    return (
                      <tr key={v.id}>
                        <td>
                          <IdLink kind="verdict" id={v.id} />
                        </td>
                        <td>
                          <IdLink kind="trace" id={v.traceId} />
                        </td>
                        <td>
                          <VerdictBadge state={v.passed ? 'pass' : 'fail'} />
                        </td>
                        <td>
                          {failed.length ? (
                            <div className="hc-stack" style={{ gap: 2 }}>
                              {failed.map((c) => (
                                <span key={c.checkId}>
                                  <Tag>{checkKindWord[c.kind]}</Tag> {c.label}
                                  <span className="hc-muted"> {c.detail}</span>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="hc-muted">None. {v.checks.length} checks passed</span>
                          )}
                        </td>
                        <td className="hc-muted">{dateTime(v.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty>No verdicts yet. Each trace is judged shortly after the shop sends it.</Empty>
            )
          }
        </Q>
      </Layer>

      <Layer title="Asking the same question two ways" aside={<Link to="/console/findings">All red team findings</Link>}>
        <Q q={findings} what="findings">
          {(list) => (list.length ? <FindingsTable findings={list.slice(0, 5)} /> : <Empty>No probes yet. Run a red team probe from the map page to ask questions two ways and compare the answers.</Empty>)}
        </Q>
      </Layer>

      <Layer title="Re-judge a trace">
        <form
          className="hc-row"
          onSubmit={(e) => {
            e.preventDefault();
            const id = traceId.trim();
            if (id) void act.run(async () => setResult(await call('POST /api/healer/traces/:id/judge', { params: { id } })));
          }}
        >
          <input className="hc-input mono" placeholder="Trace id" value={traceId} onChange={(e) => setTraceId(e.target.value)} />
          <button type="submit" className="hc-btn" disabled={act.busy || !traceId.trim()}>
            {act.busy ? 'Judging…' : 'Judge again'}
          </button>
        </form>
        <ActionError error={act.error} />
        {result && (
          <div className="hc-panel" style={{ marginTop: 10 }}>
            <div className="hc-row" style={{ marginBottom: 8 }}>
              <span className="mono">{result.id}</span> on <IdLink kind="trace" id={result.traceId} /> <VerdictBadge state={result.passed ? 'pass' : 'fail'} />
            </div>
            <CheckList checks={result.checks} />
            {result.judgeRun && (
              <div style={{ marginTop: 8 }}>
                <RawRun run={result.judgeRun} title="Judge" />
              </div>
            )}
          </div>
        )}
      </Layer>

      <Layer title="Raw workings" aside="The judge's own run on the most recent verdict that needed one" raw>
        {latestJudgeRun ? <RawRun run={latestJudgeRun} title="Judge" open /> : <Empty>No verdict has needed the model judge yet. Code checks alone settled them.</Empty>}
      </Layer>
    </>
  );
}

export function VerdictPage() {
  const { id = '' } = useParams();
  const q = useApi('GET /api/healer/verdicts/:id', [{ params: { id } }]);
  return <Q q={q} what="the verdict">{({ verdict }) => <Navigate replace to={`/console/traces/${encodeURIComponent(verdict.traceId)}#verdict`} />}</Q>;
}

const findingExplainer =
  'There is no universal judge of correctness, but there is a workaround: ask the same question two ways. The red team rewords a real request, runs both in a sandbox, and compares what the agent did. If the answers disagree, one of them is wrong, and the policy rules or a model comparison decide which. The wrong one gets a failed verdict and is diagnosed like any other failure.';

function FindingsTable({ findings }: { findings: RedTeamFinding[] }) {
  const { name } = useCustomers();
  return (
    <div className="hc-scroll">
      <table className="hc-table">
        <thead>
          <tr>
            <th>Finding</th>
            <th>Result</th>
            <th>Customer</th>
            <th>Original wording</th>
            <th>Issue filed</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.id}>
              <td>
                <IdLink kind="finding" id={f.id} />
              </td>
              <td>
                <VerdictBadge state={f.consistent ? 'pass' : 'fail'} label={f.consistent ? 'Answers agree' : 'Answers disagree'} />
              </td>
              <td>{name(f.customerId)}</td>
              <td className="clip" title={f.original.message}>
                {f.original.message}
              </td>
              <td>{f.issueId ? <IdLink kind="issue" id={f.issueId} /> : <span className="hc-muted">none</span>}</td>
              <td className="hc-muted">{dateTime(f.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FindingsPage() {
  const findings = useApi('GET /api/healer/findings', [], ['finding']);
  return (
    <>
      <PageHead title="Red team findings" crumb={<Link to="/console/judge">Judge</Link>}>
        {findingExplainer}
      </PageHead>
      <Layer title="Findings" aside={findings.data ? `${findings.data.length} probes, ${findings.data.filter((f) => !f.consistent).length} disagreed` : undefined}>
        <Q q={findings} what="findings">
          {(list) => (list.length ? <FindingsTable findings={list} /> : <Empty>No probes yet. Run a red team probe from the traffic panel on the map page.</Empty>)}
        </Q>
      </Layer>
    </>
  );
}

function Side({ title, message, traceId }: { title: string; message: string; traceId: string }) {
  const q = useApi('GET /api/healer/traces/:id', [{ params: { id: traceId } }], ['verdict']);
  return (
    <div className="hc-panel">
      <h3>
        {title}, <IdLink kind="trace" id={traceId} />
      </h3>
      <div className="hc-convo">
        <div className="hc-bubble customer">{message}</div>
        {q.data ? <div className="hc-bubble agent">{q.data.trace.output}</div> : q.error ? <Failed error={q.error} retry={q.reload} /> : <Loading what="the reply" />}
      </div>
      {q.data && (
        <>
          <p className="hc-muted" style={{ margin: '10px 0 4px' }}>
            Tool calls: {q.data.trace.toolCalls.length ? q.data.trace.toolCalls.map((t) => t.name).join(', ') : 'none'}
          </p>
          {q.data.verdict && !q.data.verdict.passed && (
            <>
              <p style={{ margin: '10px 0 4px' }}>
                <VerdictBadge state="fail" label="Judged the wrong one" />
              </p>
              <CheckList checks={q.data.verdict.checks.filter((c) => !c.passed)} />
            </>
          )}
        </>
      )}
    </div>
  );
}

export function FindingPage() {
  const { id = '' } = useParams();
  const findings = useApi('GET /api/healer/findings', [], ['finding']);
  const { name } = useCustomers();
  return (
    <Q q={findings} what="the finding">
      {(list) => {
        const f = list.find((x) => x.id === id);
        if (!f) return <Failed error={new ApiError(404, 'not_found', `Finding ${id} not found`)} />;
        return (
          <>
            <PageHead
              title={f.consistent ? 'The answers agree' : 'The answers disagree'}
              crumb={
                <>
                  <Link to="/console/findings">Red team findings</Link> <span className="mono">{f.id}</span>
                </>
              }
            >
              {findingExplainer}
            </PageHead>
            <div className="hc-panel" style={{ marginBottom: 16 }}>
              <dl className="hc-kv">
                <dt>Result</dt>
                <dd>
                  <VerdictBadge state={f.consistent ? 'pass' : 'fail'} label={f.consistent ? 'Same substance both ways' : 'Handled differently'} />
                </dd>
                <dt>Customer</dt>
                <dd>{name(f.customerId)}</dd>
                <dt>Issue filed</dt>
                <dd>{f.issueId ? <IdLink kind="issue" id={f.issueId} /> : <span className="hc-muted">{f.consistent ? 'none, nothing to fix' : 'none, it was not clear which side was wrong'}</span>}</dd>
                <dt>When</dt>
                <dd>{dateTime(f.createdAt)}</dd>
              </dl>
            </div>
            <div className="hc-cols">
              <Side title="Original" message={f.original.message} traceId={f.original.traceId} />
              <Side title="Reworded" message={f.paraphrase.message} traceId={f.paraphrase.traceId} />
            </div>
            <Layer title="Differences">
              {f.differences.length ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {f.differences.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              ) : (
                <Empty>None found. Both wordings led to the same tool calls, the same changes to the records and replies with the same substance.</Empty>
              )}
            </Layer>
            <Layer title="Raw workings" raw>
              {f.compareRun ? <RawRun run={f.compareRun} title="Comparison call" open /> : <Empty>No comparison call was recorded for this finding.</Empty>}
            </Layer>
          </>
        );
      }}
    </Q>
  );
}
