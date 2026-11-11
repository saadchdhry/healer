import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { EnvSnapshot, TraceSource } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime, int, ms, money, tierName, usd } from '../../lib/format.ts';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { RatingMark, TraceTable, useCustomers } from '../components/TraceTable.tsx';
import { TraceTimeline } from '../components/TraceTimeline.tsx';
import { CheckList, IdLink, Json, Layer, LineageStrip, PageHead, RawRun, VerdictBadge } from '../components/ui.tsx';

const sources: TraceSource[] = ['shop', 'simulator', 'seed', 'eval', 'redteam', 'replay'];

export function TracesPage() {
  const [sp, setSp] = useSearchParams();
  const source = (sp.get('source') ?? '') as TraceSource | '';
  const verdict = (sp.get('verdict') ?? '') as 'pass' | 'fail' | 'pending' | '';
  const versionId = sp.get('version') ?? '';
  const customer = sp.get('customer') ?? '';
  const versions = useApi('GET /api/healer/versions', [], ['version']);
  const { list: customers } = useCustomers();
  const traces = useApi(
    'GET /api/healer/traces',
    [{ query: { source: source || undefined, verdict: verdict || undefined, versionId: versionId ? Number(versionId) : undefined, limit: 500 } }],
    ['trace', 'verdict'],
  );
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const rows = traces.data?.filter((t) => !customer || t.customerId === customer);

  return (
    <>
      <PageHead title="Traces">
        A run is one model or tool call, a trace is everything the agent did to answer one message, and a thread is one whole conversation. Traces are the evidence
        every other stage works from: the judge reads them, diagnosis clusters them, and the eval suite borrows its realistic inputs from them.
      </PageHead>
      <Layer title="Explorer" aside={rows ? `${rows.length} traces` : undefined}>
        <div className="hc-filters">
          <label className="hc-field">
            Source
            <select className="hc-select" value={source} onChange={(e) => set('source', e.target.value)}>
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="hc-field">
            Verdict
            <select className="hc-select" value={verdict} onChange={(e) => set('verdict', e.target.value)}>
              <option value="">Any verdict</option>
              <option value="pass">Passed</option>
              <option value="fail">Failed</option>
              <option value="pending">Not judged yet</option>
            </select>
          </label>
          <label className="hc-field">
            Version
            <select className="hc-select" value={versionId} onChange={(e) => set('version', e.target.value)}>
              <option value="">Any version</option>
              {versions.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.id}
                </option>
              ))}
            </select>
          </label>
          <label className="hc-field">
            Customer
            <select className="hc-select" value={customer} onChange={(e) => set('customer', e.target.value)}>
              <option value="">Any customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Q q={traces} what="traces">
          {() => (rows?.length ? <TraceTable traces={rows} /> : <Empty>No traces match these filters. Clear a filter, or send traffic from the map page.</Empty>)}
        </Q>
      </Layer>
    </>
  );
}

function EnvChanges({ before, after }: { before: EnvSnapshot; after: EnvSnapshot }) {
  const refunds = after.refunds.filter((r) => !before.refunds.some((b) => b.id === r.id));
  const escalations = after.escalations.filter((r) => !before.escalations.some((b) => b.id === r.id));
  const orders = after.orders
    .map((o) => {
      const b = before.orders.find((x) => x.id === o.id);
      if (!b) return { id: o.id, fields: ['created'] };
      const fields = (Object.keys(o) as (keyof typeof o)[]).filter((k) => JSON.stringify(o[k]) !== JSON.stringify(b[k]));
      return { id: o.id, fields: fields.map((f) => `${f}: ${JSON.stringify(b[f])} to ${JSON.stringify(o[f])}`) };
    })
    .filter((o) => o.fields.length);
  if (!refunds.length && !escalations.length && !orders.length) return <p className="hc-muted">Nothing in the shop changed. The agent only read data.</p>;
  return (
    <ul className="hc-checks">
      {refunds.map((r) => (
        <li key={r.id}>
          <span className="hc-muted">+</span>
          <div>
            Refund <span className="mono">{r.id}</span> on <span className="mono">{r.orderId}</span>: {money(r.amount)} as {r.method.replace('_', ' ')}. Reason: {r.reason || 'none given'}
          </div>
        </li>
      ))}
      {escalations.map((e) => (
        <li key={e.id}>
          <span className="hc-muted">+</span>
          <div>
            Escalation <span className="mono">{e.id}</span>
            {e.orderId && (
              <>
                {' '}
                on <span className="mono">{e.orderId}</span>
              </>
            )}
            : {e.reason}
          </div>
        </li>
      ))}
      {orders.map((o) => (
        <li key={o.id}>
          <span className="hc-muted">~</span>
          <div>
            Order <span className="mono">{o.id}</span>: {o.fields.join('; ')}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TraceDetailPage() {
  const { id = '' } = useParams();
  const q = useApi('GET /api/healer/traces/:id', [{ params: { id } }], ['trace', 'verdict']);
  const { name } = useCustomers();
  const rejudge = useAction();

  return (
    <Q q={q} what="the trace">
      {({ trace, verdict, rating, lineage }) => (
        <>
          <PageHead title={<span className="mono" style={{ fontSize: 20 }}>{trace.id}</span>} crumb={<Link to="/console/traces">Traces</Link>}>
            One message from {name(trace.customerId)}, answered by version {trace.versionId}. Below is everything the agent saw and did, step by step.
          </PageHead>
          <LineageStrip lineage={lineage} self={{ kind: 'trace', id: trace.id }} />
          <div className="hc-cols">
            <div className="hc-panel">
              <h3>Conversation</h3>
              <div className="hc-convo">
                {trace.history.map((t, i) => (
                  <div key={i} className={`hc-bubble ${t.role}`}>
                    {t.text}
                  </div>
                ))}
                <div className="hc-bubble customer">{trace.input}</div>
                <div className="hc-bubble agent">{trace.output}</div>
              </div>
              {trace.error && <p className="hc-error">{trace.error}</p>}
            </div>
            <div className="hc-panel">
              <h3>Summary</h3>
              <dl className="hc-kv">
                <dt>Verdict</dt>
                <dd>{verdict ? <IdLink kind="verdict" id={verdict.id}><VerdictBadge state={verdict.passed ? 'pass' : 'fail'} /></IdLink> : <VerdictBadge state="pending" />}</dd>
                <dt>Customer rating</dt>
                <dd>
                  <RatingMark rating={rating} />
                </dd>
                <dt>Customer</dt>
                <dd>{name(trace.customerId)}</dd>
                <dt>Source</dt>
                <dd>{trace.source}</dd>
                <dt>Thread</dt>
                <dd className="mono">{trace.threadId}</dd>
                <dt>Version</dt>
                <dd>
                  <IdLink kind="version" id={trace.versionId} />
                </dd>
                <dt>Tier used</dt>
                <dd>{tierName[trace.tierUsed]}</dd>
                <dt>Router decision</dt>
                <dd>
                  {trace.routerDecision
                    ? `Score ${trace.routerDecision.score.toFixed(2)}, ${trace.routerDecision.needsStrong ? 'sent to the strong tier' : 'kept on the small tier'}`
                    : 'No router in this version'}
                </dd>
                <dt>Time</dt>
                <dd>
                  {dateTime(trace.startedAt)}, took {ms(trace.startedAt, trace.endedAt)}
                </dd>
                <dt>Tokens and cost</dt>
                <dd>
                  {int(trace.usage.inputTokens)} in, {int(trace.usage.outputTokens)} out, <span className="mono">{usd(trace.usage.costUsd)}</span>
                </dd>
              </dl>
            </div>
          </div>
          <ThreadList threadId={trace.threadId} current={trace.id} />
          <Layer title="Timeline" aside="Every node, model call and tool call. Click a row for its exact input and output">
            <TraceTimeline runs={trace.runs} toolCalls={trace.toolCalls} />
          </Layer>
          <Layer title="Environment" aside={`Shop state on ${trace.envBefore.today}`}>
            <div className="hc-cols">
              <div className="hc-panel">
                <h3>What changed</h3>
                <EnvChanges before={trace.envBefore} after={trace.envAfter} />
              </div>
              <div className="hc-panel">
                <h3>Tool calls</h3>
                {trace.toolCalls.length ? (
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, overflowWrap: 'anywhere' }}>
                    {trace.toolCalls.map((t) => (
                      <li key={t.runId}>
                        <span className="mono">{t.name}</span> <span className="hc-muted mono">{JSON.stringify(t.input)}</span>
                        {t.blockedByGuard && <span className="hc-verdict fail"> blocked by {t.blockedByGuard}</span>}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="hc-muted">No tools were called.</p>
                )}
              </div>
            </div>
            <details className="hc-raw" style={{ marginTop: 10 }}>
              <summary>
                <strong>Full snapshots</strong>
                <span className="meta">before and after, exactly as recorded</span>
              </summary>
              <div className="hc-raw-body">
                <div>
                  <h4>Before</h4>
                  <Json value={trace.envBefore} />
                </div>
                <div>
                  <h4>After</h4>
                  <Json value={trace.envAfter} />
                </div>
              </div>
            </details>
          </Layer>
          <Layer
            title="Verdict"
            aside={
              <button type="button" className="hc-btn" disabled={rejudge.busy} onClick={() => rejudge.run(async () => { await call('POST /api/healer/traces/:id/judge', { params: { id: trace.id } }); q.reload(); })}>
                {rejudge.busy ? 'Judging…' : 'Judge again'}
              </button>
            }
          >
            <ActionError error={rejudge.error} />
            {verdict ? <CheckList checks={verdict.checks} /> : <Empty>Not judged yet. The judge runs on every trace shortly after it arrives, or use Judge again.</Empty>}
          </Layer>
          <Layer title="Raw workings" raw>
            {trace.runs
              .filter((r) => r.kind === 'model')
              .map((r, i) => (
                <RawRun key={r.id} run={r} title={`Agent model call ${i + 1}`} />
              ))}
            {verdict?.judgeRun && <RawRun run={verdict.judgeRun} title="Judge" />}
          </Layer>
        </>
      )}
    </Q>
  );
}

function ThreadList({ threadId, current }: { threadId: string; current: string }) {
  const q = useApi('GET /api/healer/threads/:id', [{ params: { id: threadId } }], ['trace']);
  if (!q.data || q.data.length < 2) return null;
  return (
    <Layer title="Thread" aside={`${q.data.length} traces in this conversation`}>
      <TraceTable traces={q.data} highlight={new Set([current])} />
    </Layer>
  );
}
