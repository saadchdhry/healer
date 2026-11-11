import { Link, useParams } from 'react-router-dom';
import type { Issue } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime } from '../../lib/format.ts';
import { useConsole } from '../stream.tsx';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { TraceTable, useCustomers } from '../components/TraceTable.tsx';
import { CauseTag, IdLink, JobProgress, Layer, LineageStrip, PageHead, RawRun, ScopeTag, SurfaceTag, Tag, humanize } from '../components/ui.tsx';

const explainer =
  'Why did it go wrong, and which part is at fault? Diagnosis clusters failed traces into issues and assigns the blame: missing knowledge points at the context, a loose process at the harness, and a lack of capability at the model. It also names a scope, because a personal preference saved as a shop-wide rule is a wrong diagnosis.';

const statusOrder: Issue['status'][] = ['open', 'proposed', 'fixed', 'dismissed'];

export function DiagnosePage() {
  const issues = useApi('GET /api/healer/issues', [], ['issue']);
  const { name } = useCustomers();
  const { jobs, trackJob } = useConsole();
  const act = useAction();
  const running = jobs.filter((j) => j.kind === 'diagnose' && j.status === 'running');
  const withRun = issues.data?.filter((i) => i.diagnoseRun).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return (
    <>
      <PageHead title="Diagnose">{explainer}</PageHead>
      <Layer
        title="Issues"
        aside={
          <button type="button" className="hc-btn" disabled={act.busy} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/diagnose')))}>
            Run diagnosis on unclustered failures
          </button>
        }
      >
        <ActionError error={act.error} />
        {running.map((j) => (
          <div key={j.id} className="hc-panel" style={{ marginBottom: 10 }}>
            <JobProgress job={j} />
          </div>
        ))}
        <Q q={issues} what="issues">
          {(list) =>
            list.length ? (
              <table className="hc-table">
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>Title</th>
                    <th>Cause</th>
                    <th>Surface</th>
                    <th>Scope</th>
                    <th>Status</th>
                    <th className="num">Traces</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {list
                    .slice()
                    .sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt))
                    .map((i) => (
                      <tr key={i.id}>
                        <td>
                          <IdLink kind="issue" id={i.id} />
                        </td>
                        <td>{i.title}</td>
                        <td>
                          <CauseTag cause={i.cause} />
                        </td>
                        <td>
                          <SurfaceTag surface={i.surface} />
                        </td>
                        <td>
                          <ScopeTag scope={i.scope} name={name} />
                        </td>
                        <td>{humanize(i.status)}</td>
                        <td className="num">{i.traceIds.length}</td>
                        <td className="hc-muted">{dateTime(i.updatedAt)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <Empty>No issues yet. Once the judge has failed some traces, run diagnosis to cluster them into issues.</Empty>
            )
          }
        </Q>
      </Layer>
      <Layer title="Raw workings" aside={withRun ? `Diagnosis call behind ${withRun.id}` : undefined} raw>
        {withRun?.diagnoseRun ? <RawRun run={withRun.diagnoseRun} title="Diagnose" open /> : <Empty>The exact diagnosis prompt and response appear here after the first diagnosis.</Empty>}
      </Layer>
    </>
  );
}

export function IssuePage() {
  const { id = '' } = useParams();
  const q = useApi('GET /api/healer/issues/:id', [{ params: { id } }], ['issue', 'proposal']);
  const traces = useApi('GET /api/healer/traces', [{ query: { limit: 500 } }], ['trace', 'verdict']);
  const probeTraces = useApi('GET /api/healer/traces', [{ query: { source: 'redteam', limit: 500 } }], ['trace', 'verdict']);
  const { name } = useCustomers();
  const { jobs, trackJob } = useConsole();
  const act = useAction();
  const proposeJob = jobs.find((j) => j.kind === 'propose' && j.refId === id && j.status !== 'done');

  return (
    <Q q={q} what="the issue">
      {({ issue, lineage }) => {
        const rows = [...(traces.data ?? []), ...(probeTraces.data ?? [])].filter((t) => issue.traceIds.includes(t.id));
        const closed = issue.status === 'dismissed' || issue.status === 'fixed';
        return (
          <>
            <PageHead title={issue.title} crumb={<><Link to="/console/diagnose">Diagnose</Link> <span className="mono">{issue.id}</span></>}>
              {explainer}
            </PageHead>
            <LineageStrip lineage={lineage} self={{ kind: 'issue', id: issue.id }} />
            <div className="hc-cols">
              <div className="hc-panel">
                <h3>Diagnosis</h3>
                <p style={{ marginTop: 0 }}>{issue.summary}</p>
                <dl className="hc-kv">
                  <dt>Cause</dt>
                  <dd>
                    <CauseTag cause={issue.cause} />
                  </dd>
                  <dt>Surface to change</dt>
                  <dd>
                    <SurfaceTag surface={issue.surface} />
                  </dd>
                  <dt>Scope</dt>
                  <dd>
                    <ScopeTag scope={issue.scope} name={name} />
                  </dd>
                  <dt>Status</dt>
                  <dd>
                    <Tag>{humanize(issue.status)}</Tag>
                  </dd>
                  <dt>Found</dt>
                  <dd>{dateTime(issue.createdAt)}</dd>
                </dl>
              </div>
              <div className="hc-panel">
                <h3>Follow-up</h3>
                <dl className="hc-kv">
                  <dt>Proposals</dt>
                  <dd>{issue.proposalIds.length ? issue.proposalIds.map((p) => <div key={p}><IdLink kind="proposal" id={p} /></div>) : <span className="hc-muted">None yet</span>}</dd>
                  <dt>Eval cases</dt>
                  <dd>{issue.evalCaseIds.length ? issue.evalCaseIds.map((e) => <div key={e}><IdLink kind="evalCase" id={e} /></div>) : <span className="hc-muted">None yet</span>}</dd>
                </dl>
                <div className="hc-row" style={{ marginTop: 12 }}>
                  <button type="button" className="hc-btn primary" disabled={act.busy || closed} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/issues/:id/propose', { params: { id: issue.id } })))}>
                    Propose a fix
                  </button>
                  <button
                    type="button"
                    className="hc-btn"
                    disabled={act.busy || closed}
                    onClick={() =>
                      act.run(async () => {
                        await call('POST /api/healer/issues/:id/dismiss', { params: { id: issue.id } });
                        q.reload();
                      })
                    }
                  >
                    Dismiss
                  </button>
                </div>
                {proposeJob && (
                  <div style={{ marginTop: 10 }}>
                    <JobProgress job={proposeJob} />
                  </div>
                )}
                <ActionError error={act.error} />
              </div>
            </div>
            <Layer title="Traces in this issue" aside={`${issue.traceIds.length} traces`}>
              {rows.length ? <TraceTable traces={rows} showOutput /> : <Empty>{traces.loading ? 'Loading traces…' : 'The traces behind this issue are no longer stored.'}</Empty>}
            </Layer>
            <Layer title="Raw workings" raw>
              {issue.diagnoseRun ? <RawRun run={issue.diagnoseRun} title="Diagnose" open /> : <Empty>This issue was filed by hand, so there is no diagnosis call to show.</Empty>}
            </Layer>
          </>
        );
      }}
    </Q>
  );
}
