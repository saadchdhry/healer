import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime, modelLabel, pct, usd } from '../../lib/format.ts';
import { useConsole } from '../stream.tsx';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { useCustomers } from '../components/TraceTable.tsx';
import { VersionDiff } from '../components/VersionDiff.tsx';
import { IdLink, Json, Layer, LineageStrip, PageHead, Tag, humanize } from '../components/ui.tsx';
import { CaseComparison } from './Gate.tsx';

export function VersionPage() {
  const { id = '' } = useParams();
  const q = useApi('GET /api/healer/versions/:id', [{ params: { id } }], ['version', 'evalRun']);
  const { list: customers } = useCustomers();
  const { refreshOverview } = useConsole();
  const [confirming, setConfirming] = useState(false);
  const act = useAction();
  const navigate = useNavigate();

  return (
    <Q q={q} what="the version">
      {({ version: v, parent, latestRun, lineage }) => (
        <>
          <PageHead title={<>Version {v.id}</>} crumb={<Link to="/console/harness">Versions</Link>}>
            A version bundles all three surfaces: context, harness and model. Versions are only ever added, so rolling back deploys a copy of an older version as a new
            one, and the history stays intact.
          </PageHead>
          <LineageStrip lineage={lineage} self={{ kind: 'version', id: String(v.id) }} />
          <div className="hc-cols">
            <div className="hc-panel">
              <h3>{v.summary}</h3>
              <dl className="hc-kv">
                <dt>Status</dt>
                <dd>
                  <Tag>{humanize(v.status)}</Tag>
                </dd>
                <dt>Author</dt>
                <dd>{v.author === 'factory' ? 'Factory' : v.author === 'loop' ? 'The loop' : 'A human'}</dd>
                <dt>Gated</dt>
                <dd>{v.gated ? 'Yes' : <span style={{ color: 'var(--warn)' }}>No, deployed without the gate</span>}</dd>
                <dt>Parent</dt>
                <dd>{v.parentId !== null ? <IdLink kind="version" id={v.parentId} /> : <span className="hc-muted">none</span>}</dd>
                <dt>Proposal</dt>
                <dd>{v.proposalId ? <IdLink kind="proposal" id={v.proposalId} /> : <span className="hc-muted">none</span>}</dd>
                <dt>Model</dt>
                <dd>{modelLabel(v.model)}</dd>
                <dt>Notes</dt>
                <dd>{v.context.length}</dd>
                <dt>Created</dt>
                <dd>{dateTime(v.createdAt)}</dd>
              </dl>
            </div>
            <div className="hc-panel">
              <h3>Rollback</h3>
              {v.status === 'live' ? (
                <p className="hc-muted" style={{ margin: 0 }}>
                  This is the live version.
                </p>
              ) : !confirming ? (
                <button type="button" className="hc-btn" onClick={() => setConfirming(true)}>
                  Roll back to this version
                </button>
              ) : (
                <div className="hc-stack" style={{ gap: 8 }}>
                  <p style={{ margin: 0 }}>A copy of version {v.id} becomes the new live version in the shop straight away, without the gate.</p>
                  <div className="hc-row">
                    <button
                      type="button"
                      className="hc-btn primary"
                      disabled={act.busy}
                      onClick={() =>
                        act.run(async () => {
                          const nv = await call('POST /api/healer/versions/:id/rollback', { params: { id: v.id } });
                          refreshOverview();
                          setConfirming(false);
                          navigate(`/console/versions/${nv.id}`);
                        })
                      }
                    >
                      Deploy a copy now
                    </button>
                    <button type="button" className="hc-btn" onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <ActionError error={act.error} />
            </div>
          </div>
          <Layer title="What changed from its parent">{parent ? <VersionDiff base={parent} candidate={v} customers={customers} /> : <Empty>The factory version has no parent.</Empty>}</Layer>
          <Layer title="Its eval run" aside={latestRun ? <><IdLink kind="evalRun" id={latestRun.id} />, {pct(latestRun.passRate)} pass rate, {usd(latestRun.costPerTaskUsd)} per task</> : undefined}>
            {latestRun ? <CaseComparison base={null} candidate={latestRun} /> : <Empty>This version has not run the eval suite. Run it from the eval suite page.</Empty>}
          </Layer>
          <Layer title="Raw workings" aside="The version exactly as stored" raw>
            <Json value={v} />
          </Layer>
        </>
      )}
    </Q>
  );
}
