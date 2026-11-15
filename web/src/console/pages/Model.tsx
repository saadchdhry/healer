import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { RouterExample, RouterModel, Tier } from '@healer/agent';
import { ApiError, call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime, modelLabel, pct, tierName } from '../../lib/format.ts';
import { useConsole } from '../stream.tsx';
import { LossCurve } from '../components/Charts.tsx';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { IdLink, JobProgress, Json, Layer, PageHead, VerdictBadge } from '../components/ui.tsx';

const tiers: Tier[] = ['haiku', 'sonnet', 'opus'];

const reasonLabel: Record<NonNullable<RouterExample['reason']>, { label: string; detail: string }> = {
  high_stakes: { label: 'High stakes', detail: 'A replay attempted a refund or a cancellation, whether or not a guard blocked it' },
  measured_failure: { label: 'Measured failure', detail: 'A small tier replay got it wrong where the strong tier kept every rule' },
};

export function ModelPage() {
  const q = useApi('GET /api/healer/model', [], ['version', 'evalRun']);
  const { overview, jobs, trackJob, refreshOverview } = useConsole();
  const liveId = overview?.liveVersionId;
  const liveVersion = useApi('GET /api/healer/versions/:id', [{ params: { id: liveId ?? 0 } }], ['version'], liveId !== undefined);
  const [maxExamples, setMax] = useState(40);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmTier, setConfirmTier] = useState<Tier | null>(null);
  const act = useAction();
  const [trainNote, setTrainNote] = useState<string | null>(null);
  const navigate = useNavigate();
  const datasetJob = jobs.find((j) => j.kind === 'router_dataset' && j.status === 'running');
  const lastDataset = jobs.find((j) => j.kind === 'router_dataset');
  const lastDatasetKey = lastDataset ? `${lastDataset.id}:${lastDataset.status}` : '';
  const reload = q.reload;
  useEffect(() => {
    if (lastDatasetKey && !lastDatasetKey.endsWith(':running')) reload();
  }, [lastDatasetKey, reload]);

  return (
    <>
      <PageHead title="Model" accent="var(--model)">
        The model is the reasoning engine, and improving it means changing weights, which is slow and expensive. Claude cannot be fine-tuned here, so moving up a tier
        stands in for better weights. A small router trained on this demo's own traces is the one place where weights really change: it learns which requests
        carry risk and sends those to the stronger model, while lookups and questions stay on the small one.
      </PageHead>
      <Q q={q} what="the model view">
        {(m) => {
          const router = m.routers.find((r) => r.id === selected) ?? m.routers.at(-1);
          const train = m.dataset.filter((d) => d.split === 'train');
          const val = m.dataset.filter((d) => d.split === 'val');
          const liveTier = m.live.mode === 'fixed' ? m.live.tier : null;
          return (
            <>
              <div className="hc-cols">
                <Layer title="Live model config">
                  <div className="hc-panel hc-stack">
                    <div style={{ fontSize: 16 }}>{modelLabel(m.live)}</div>
                    {liveVersion.data && (
                      <p className="hc-muted" style={{ margin: 0, fontSize: 13 }}>
                        Live version <IdLink kind="version" id={liveVersion.data.version.id} />.{' '}
                        {liveVersion.data.version.author === 'factory' ? (
                          'The factory version.'
                        ) : liveVersion.data.version.gated ? (
                          'It passed the gate before it was deployed.'
                        ) : (
                          <span style={{ color: 'var(--warn)' }}>Deployed without the gate, so no eval run vouches for it.</span>
                        )}
                      </p>
                    )}
                    <div>
                      <div className="hc-field" style={{ marginBottom: 6 }}>
                        Manual tier picker
                      </div>
                      <div className="hc-seg" role="group" aria-label="Tier">
                        {tiers.map((t) => (
                          <button key={t} type="button" aria-pressed={liveTier === t} onClick={() => setConfirmTier(t)} disabled={act.busy || liveTier === t}>
                            {tierName[t]}
                          </button>
                        ))}
                      </div>
                      <p className="hc-muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
                        Deploys straight to the shop without the gate. The new version is marked as not gated.
                      </p>
                    </div>
                    {confirmTier && (
                      <div className="hc-banner" style={{ margin: 0 }}>
                        <span>
                          Deploy {tierName[confirmTier]} to the shop now, skipping the gate?
                        </span>
                        <span className="hc-spacer" />
                        <button
                          type="button"
                          className="hc-btn primary"
                          disabled={act.busy}
                          onClick={() =>
                            act.run(async () => {
                              await call('POST /api/healer/model/tier', { body: { tier: confirmTier } });
                              setConfirmTier(null);
                              q.reload();
                              refreshOverview();
                            })
                          }
                        >
                          Deploy without the gate
                        </button>
                        <button type="button" className="hc-btn" onClick={() => setConfirmTier(null)}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </Layer>
                <Layer title="Prices" aside="Dollars per million tokens">
                  <table className="hc-table">
                    <thead>
                      <tr>
                        <th>Tier</th>
                        <th>Model</th>
                        <th className="num">Input</th>
                        <th className="num">Output</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tiers.map((t) => (
                        <tr key={t}>
                          <td>{tierName[t]}</td>
                          <td className="mono">{m.pricing[t].modelId}</td>
                          <td className="num mono">${m.pricing[t].inputPerMTok.toFixed(2)}</td>
                          <td className="num mono">${m.pricing[t].outputPerMTok.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Layer>
              </div>

              <Layer title="The router" aside="Toy scale: a bag-of-words classifier on a few dozen examples">
                <div className="hc-row" style={{ marginBottom: 12 }}>
                  <label className="hc-row" style={{ fontSize: 13 }}>
                    Up to
                    <input className="hc-input" type="number" min={4} max={200} aria-label="Most examples to build" value={maxExamples} onChange={(e) => setMax(Number(e.target.value))} style={{ width: 72 }} />
                    examples
                  </label>
                  <button type="button" className="hc-btn" disabled={act.busy || !!datasetJob} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/model/router/dataset', { body: { maxExamples } })))}>
                    Build dataset
                  </button>
                  <button
                    type="button"
                    className="hc-btn"
                    disabled={act.busy || m.dataset.length < 4}
                    onClick={() =>
                      act.run(async () => {
                        setTrainNote(null);
                        try {
                          const r = await call('POST /api/healer/model/router/train');
                          setSelected(r.id);
                          q.reload();
                        } catch (e) {
                          if (e instanceof ApiError && e.status === 409) setTrainNote(e.message);
                          else throw e;
                        }
                      })
                    }
                  >
                    Train
                  </button>
                  <button
                    type="button"
                    className="hc-btn primary"
                    disabled={act.busy || !router}
                    onClick={() =>
                      act.run(async () => {
                        const p = await call('POST /api/healer/model/router/:id/propose', { params: { id: router!.id } });
                        navigate(`/console/proposals/${p.id}`);
                      })
                    }
                  >
                    Propose a routed config{router ? ` with ${router.id}` : ''}
                  </button>
                </div>
                <ActionError error={act.error} />
                {trainNote && (
                  <div className="hc-panel" role="status" style={{ marginBottom: 12 }}>
                    <strong>Nothing to train on yet.</strong> {trainNote}
                    <p className="hc-muted" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
                      This is an expected state, not a fault. A router only learns something when some requests carry risk: a replay attempted a refund or a
                      cancellation, or the small tier failed where the strong one kept every rule.
                      The dataset that was built is listed below.
                    </p>
                  </div>
                )}
                {datasetJob && (
                  <div className="hc-panel" style={{ marginBottom: 12 }}>
                    <JobProgress job={datasetJob} />
                  </div>
                )}
                <div className="hc-cols">
                  <div className="hc-panel">
                    <h3>
                      Loss curve{router ? `, ${router.id}` : ''}
                    </h3>
                    {router ? (
                      <>
                        <LossCurve curve={router.metrics.lossCurve} label={`Training loss for router ${router.id}`} />
                        <dl className="hc-kv" style={{ marginTop: 10 }}>
                          <dt>Train accuracy</dt>
                          <dd className="mono">
                            {pct(router.metrics.trainAccuracy)} on {router.metrics.trainSize}
                          </dd>
                          <dt>Validation accuracy</dt>
                          <dd className="mono">
                            {pct(router.metrics.valAccuracy)} on {router.metrics.valSize} held out
                          </dd>
                          <dt>Carry risk</dt>
                          <dd className="mono">
                            {router.metrics.trainPositives} of {router.metrics.trainSize} in training, {router.metrics.valPositives} of {router.metrics.valSize} in validation
                          </dd>
                          <dt>Risky requests caught</dt>
                          <dd className="mono">{router.metrics.valRecall === null ? 'no risky requests held out' : `${pct(router.metrics.valRecall)} of held-out risky requests sent to the strong tier`}</dd>
                          <dt>Threshold</dt>
                          <dd className="mono">{router.threshold}</dd>
                        </dl>
                        {router.metrics.valPositives === 0 && (
                          <p className="hc-muted" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
                            None of the held-out requests carry risk, so validation accuracy says nothing about risky requests: a router that sends
                            everything to the small tier would score the same.
                          </p>
                        )}
                      </>
                    ) : (
                      <Empty>No router trained yet. Build a dataset, then train.</Empty>
                    )}
                  </div>
                  <div className="hc-panel">
                    <h3>Weights versions</h3>
                    {m.routers.length ? (
                      <table className="hc-table">
                        <thead>
                          <tr>
                            <th>Router</th>
                            <th>Trained</th>
                            <th className="num">Examples</th>
                            <th className="num">Train</th>
                            <th className="num">Validation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.routers
                            .slice()
                            .reverse()
                            .map((r) => (
                              <tr key={r.id} className={r.id === router?.id ? 'is-hl' : undefined} onClick={() => setSelected(r.id)} style={{ cursor: 'pointer' }}>
                                <td className="mono">{r.id}</td>
                                <td className="hc-muted">{dateTime(r.createdAt)}</td>
                                <td className="num">{r.metrics.trainSize + r.metrics.valSize}</td>
                                <td className="num mono">{pct(r.metrics.trainAccuracy)}</td>
                                <td className="num mono">{pct(r.metrics.valAccuracy)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    ) : (
                      <Empty>Each training run saves a new weights version here.</Empty>
                    )}
                    {router && <TopWeights router={router} />}
                  </div>
                </div>
              </Layer>

              <Layer
                title="Labelled examples"
                aside={`${train.length} train, ${val.length} validation. ${m.dataset.filter((d) => d.needsStrong).length} carry risk and go to the strong tier, ${m.dataset.filter((d) => !d.needsStrong).length} stay on the small one`}
              >
                <p className="hc-muted" style={{ margin: '0 0 10px', fontSize: 12.5 }}>
                  Known weakness: a request the agent rightly refuses, such as a refund past the 30-day window, is labelled low risk when no replay attempted the
                  refund, so the router learns to keep such requests on the small tier; one reaches the strong tier only when its wording happens to match
                  high-stakes requests, which is no guarantee.
                </p>
                {m.dataset.length ? (
                  <table className="hc-table">
                    <thead>
                      <tr>
                        <th>Example</th>
                        <th>Request</th>
                        <th>Split</th>
                        <th>Small tier</th>
                        <th>Strong tier</th>
                        <th>Label</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.dataset.map((d) => (
                        <tr key={d.id}>
                          <td className="mono hc-muted">{d.id}</td>
                          <td>{d.text}</td>
                          <td>{d.split === 'train' ? 'Train' : 'Validation'}</td>
                          <td>
                            <IdLink kind="trace" id={d.easyTraceId}>
                              <VerdictBadge state={d.easyPassed ? 'pass' : 'fail'} label={d.easyPassed ? 'passed' : 'failed'} />
                            </IdLink>
                          </td>
                          <td>
                            <IdLink kind="trace" id={d.hardTraceId}>
                              <VerdictBadge state={d.hardPassed ? 'pass' : 'fail'} label={d.hardPassed ? 'passed' : 'failed'} />
                            </IdLink>
                          </td>
                          <td>{d.needsStrong ? <strong>Needs the strong tier</strong> : 'Small tier is enough'}</td>
                          <td>{d.reason ? <span title={reasonLabel[d.reason].detail}>{reasonLabel[d.reason].label}</span> : <span className="hc-muted">Low risk</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty>No examples yet. Building the dataset replays past requests on both tiers; a request needs the strong tier when a replay attempted a refund or a cancellation, or when the small one failed where the strong one kept every rule.</Empty>
                )}
              </Layer>
              <Layer title="Raw workings" aside={router ? `Router ${router.id}, exactly as stored` : undefined} raw>
                {router ? <Json value={router} /> : <Empty>Train a router to see its vocabulary, weights and bias.</Empty>}
              </Layer>
            </>
          );
        }}
      </Q>
    </>
  );
}

function TopWeights({ router }: { router: RouterModel }) {
  const pairs = router.vocabulary.map((w, i) => ({ w, v: router.weights[i] ?? 0 })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const top = pairs.slice(0, 8);
  const max = Math.max(...top.map((p) => Math.abs(p.v)), 0.0001);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="hc-field" style={{ marginBottom: 4 }}>
        Strongest words, {router.id}. Right pushes toward the strong tier, left toward the small one
      </div>
      {top.map((p) => (
        <div key={p.w} className="hc-meter" style={{ gridTemplateColumns: '80px 1fr 1fr 48px' }}>
          <span className="mono">{p.w}</span>
          <span className="track" style={{ direction: 'rtl', borderRadius: '3px 0 0 3px' }}>
            {p.v < 0 && <span className="fill" style={{ display: 'block', width: `${(-p.v / max) * 100}%`, borderRadius: '3px 0 0 3px' }} />}
          </span>
          <span className="track">{p.v > 0 && <span className="fill" style={{ display: 'block', width: `${(p.v / max) * 100}%`, background: 'var(--model)' }} />}</span>
          <span className="num">{p.v.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}
