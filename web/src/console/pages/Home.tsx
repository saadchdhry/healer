import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Autonomy } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { ago, modelLabel, pct, time } from '../../lib/format.ts';
import { useConsole } from '../stream.tsx';
import { ConceptMap } from '../ConceptMap.tsx';
import { CostMeter, PassRateChart } from '../components/Charts.tsx';
import { ActionError, Failed, Q } from '../components/States.tsx';
import { IdLink, JobProgress, PageHead, humanize } from '../components/ui.tsx';

export function Home() {
  const { overview, overviewError, activeStages, refreshOverview } = useConsole();
  const graphs = useApi('GET /api/healer/graphs', []);
  return (
    <>
      <PageHead title="The learning loop">
        A self-improving agent is an agent plus a ratchet: every failure becomes a permanent test, and a change is only kept if it passes every test collected so far.
        Every block below is live and opens its deep dive.
      </PageHead>
      {overviewError ? <Failed error={overviewError} retry={refreshOverview} /> : null}
      <div className="hc-panel" style={{ padding: 8, marginBottom: 16 }}>
        <ConceptMap overview={overview} active={activeStages} loop={graphs.data?.loop ?? null} />
      </div>
      <div className="hc-home">
        <div className="hc-home-col">
          <LivePanel />
          <AutonomyPanel />
          <TrafficPanel />
        </div>
        <div className="hc-home-col">
          <JobsPanel />
          <PassRatePanel />
          <div className="hc-panel">
            <h3>Spend this session, by role</h3>
            {overview ? <CostMeter byRole={overview.cost.byRole} total={overview.cost.totalUsd} /> : <p className="hc-muted">Loading…</p>}
          </div>
        </div>
        <div className="hc-home-col">
          <ActivityPanel />
          <ResetPanel />
        </div>
      </div>
    </>
  );
}

function LivePanel() {
  const { overview } = useConsole();
  if (!overview) return null;
  return (
    <div className="hc-panel">
      <h3>Live in the shop</h3>
      <dl className="hc-kv">
        <dt>Version</dt>
        <dd>
          <IdLink kind="version" id={overview.liveVersionId} />
        </dd>
        <dt>Model</dt>
        <dd>{modelLabel(overview.liveModel)}</dd>
        <dt>Pass rate</dt>
        <dd className="mono">{pct(overview.latestPassRate)}</dd>
        <dt>Shop</dt>
        <dd>
          <span className={`hc-dot ${overview.shopConnected ? 'ok' : 'bad'}`} />
          {overview.shopConnected ? 'Connected, receiving traces' : 'Not reachable. Start the shop service.'}
        </dd>
      </dl>
    </div>
  );
}

const autonomyText: Record<Autonomy, string> = {
  manual: 'You drive every step. Nothing runs on its own.',
  approve: 'The loop judges, diagnoses, proposes and gates in the background. You approve each promotion.',
  auto: 'The loop promotes any candidate the gate accepts. The North Star, not the norm today.',
};

export function AutonomyPanel() {
  const { overview, refreshOverview } = useConsole();
  const act = useAction();
  const current = overview?.settings.autonomy;
  const set = (autonomy: Autonomy) =>
    act.run(async () => {
      await call('PUT /api/healer/settings', { body: { autonomy } });
      refreshOverview();
    });
  return (
    <div className="hc-panel">
      <h3>Autonomy</h3>
      <div className="hc-seg" role="group" aria-label="Autonomy level">
        {(['manual', 'approve', 'auto'] as const).map((a) => (
          <button key={a} type="button" aria-pressed={current === a} disabled={act.busy} onClick={() => set(a)}>
            {a === 'manual' ? 'Manual' : a === 'approve' ? 'Approve' : 'Automatic'}
          </button>
        ))}
      </div>
      {current && <p className="hc-sub" style={{ margin: '8px 0 0', fontSize: 13 }}>{autonomyText[current]}</p>}
      <ActionError error={act.error} />
    </div>
  );
}

function TrafficPanel() {
  const { trackJob } = useConsole();
  const seeds = useApi('GET /api/healer/seeds', []);
  const [count, setCount] = useState(10);
  const [seed, setSeed] = useState('');
  const [probes, setProbes] = useState(3);
  const act = useAction();
  const chosen = seed || seeds.data?.[0]?.id || '';
  const picked = seeds.data?.find((s) => s.id === chosen);
  return (
    <div className="hc-panel">
      <h3>Traffic</h3>
      <div className="hc-stack" style={{ gap: 10 }}>
        <div className="hc-row">
          <input className="hc-input" type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 64 }} aria-label="Number of simulated customers" />
          <button type="button" className="hc-btn" disabled={act.busy || count < 1} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/simulate', { body: { count } })))}>
            Send simulated customers
          </button>
        </div>
        <div className="hc-stack" style={{ gap: 4 }}>
          <div className="hc-row">
            <select className="hc-select" value={chosen} onChange={(e) => setSeed(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="Seeded case">
              {seeds.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            <button type="button" className="hc-btn" disabled={act.busy || !chosen} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/seeds/:id/fire', { params: { id: chosen } })))}>
              Fire
            </button>
          </div>
          {picked && <span className="hc-muted" style={{ fontSize: 12.5 }}>Shows: {picked.teaches}</span>}
          {seeds.error ? <Failed error={seeds.error} retry={seeds.reload} /> : null}
        </div>
        <div className="hc-row">
          <input className="hc-input" type="number" min={1} max={20} value={probes} onChange={(e) => setProbes(Number(e.target.value))} style={{ width: 64 }} aria-label="Number of red team pairs" />
          <button type="button" className="hc-btn" disabled={act.busy || probes < 1} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/redteam', { body: { count: probes } })))}>
            Run red team probe
          </button>
        </div>
        <span className="hc-muted" style={{ fontSize: 12.5 }}>
          A probe asks the same question two ways and flags answers that disagree.
        </span>
      </div>
      <ActionError error={act.error} />
    </div>
  );
}

function JobsPanel() {
  const { jobs } = useConsole();
  const running = jobs.filter((j) => j.status === 'running');
  const recent = jobs.filter((j) => j.status !== 'running').slice(0, 3);
  return (
    <div className="hc-panel">
      <h3>
        Jobs <span className="hc-muted" style={{ fontWeight: 400 }}>{running.length} running</span>
      </h3>
      {jobs.length === 0 && <p className="hc-muted" style={{ margin: 0 }}>No jobs yet. Sending traffic, diagnosing, gating and training each start one.</p>}
      {[...running, ...recent].map((j) => (
        <JobProgress key={j.id} job={j} />
      ))}
    </div>
  );
}

function PassRatePanel() {
  const versions = useApi('GET /api/healer/versions', [], ['version']);
  const runs = useApi('GET /api/healer/eval-runs', [], ['evalRun', 'gateRun']);
  return (
    <div className="hc-panel">
      <h3>Pass rate by version</h3>
      <Q q={versions} what="versions">
        {(v) => <Q q={runs} what="eval runs">{(r) => <PassRateChart versions={v} runs={r} />}</Q>}
      </Q>
    </div>
  );
}

function ActivityPanel() {
  const { activity, freshActivity } = useConsole();
  return (
    <div className="hc-panel">
      <h3>Activity</h3>
      {activity.length === 0 ? (
        <p className="hc-muted">Nothing has happened yet. Chat in the shop or send simulated customers and each step of the loop is logged here.</p>
      ) : (
        <ul className="hc-feed" style={{ maxHeight: 520, overflowY: 'auto' }}>
          {activity.slice(0, 40).map((a) => (
            <li key={a.id} className={freshActivity.has(a.id) ? 'is-new' : undefined}>
              <time dateTime={a.at} title={ago(a.at)}>
                {time(a.at).slice(0, 5)}
              </time>
              <span className="stage">{humanize(a.stage)}</span>
              <span>
                {a.text}
                {a.ref && (
                  <>
                    {' '}
                    <IdLink kind={a.ref.kind} id={a.ref.id}>
                      {a.ref.kind === 'version' ? `v${a.ref.id}` : a.ref.id}
                    </IdLink>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p style={{ margin: '8px 0 0', fontSize: 12.5 }}>
        <Link to="/console/run">Live conversations from the shop</Link>
      </p>
    </div>
  );
}

function ResetPanel() {
  const { refreshOverview } = useConsole();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const act = useAction();
  return (
    <div className="hc-panel">
      <h3>Reset to factory</h3>
      {!confirming ? (
        <div className="hc-row">
          <span className="hc-muted" style={{ fontSize: 13, flex: 1 }}>
            {done ? 'Reset done. Version 0 is live.' : 'Back to version 0 with no history.'}
          </span>
          <button type="button" className="hc-btn danger" onClick={() => setConfirming(true)}>
            Reset to factory
          </button>
        </div>
      ) : (
        <div className="hc-stack" style={{ gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13 }}>
            This deletes every trace, verdict, issue, proposal, gate run, eval run and version after version 0, restores the shop's orders, and deploys the factory
            agent. It cannot be undone.
          </p>
          <div className="hc-row">
            <button
              type="button"
              className="hc-btn danger primary"
              disabled={act.busy}
              onClick={() =>
                act.run(async () => {
                  await call('POST /api/healer/reset');
                  setConfirming(false);
                  setDone(true);
                  refreshOverview();
                })
              }
            >
              {act.busy ? 'Resetting…' : 'Reset everything'}
            </button>
            <button type="button" className="hc-btn" onClick={() => setConfirming(false)}>
              Keep everything
            </button>
          </div>
        </div>
      )}
      <ActionError error={act.error} />
    </div>
  );
}
