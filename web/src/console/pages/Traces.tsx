import { useEffect } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import type { EnvSnapshot, RefundRequest, TraceSource } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime, int, ms, money, sourceWord, tierName, usd } from '../../lib/format.ts';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { RatingMark, TraceTable, useCustomers } from '../components/TraceTable.tsx';
import { TraceSources } from '../components/TraceSources.tsx';
import { TraceRoute } from '../components/GraphFlow.tsx';
import { TraceTimeline } from '../components/TraceTimeline.tsx';
import { CheckList, IdLink, Json, Layer, LineageStrip, PageHead, RawRun, VerdictBadge } from '../components/ui.tsx';

const liveSources: TraceSource[] = ['shop', 'simulator', 'seed'];
const sandboxSources: TraceSource[] = ['eval', 'redteam', 'replay'];

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
    [{ query: { source: source || undefined, verdict: verdict || undefined, versionId: versionId ? Number(versionId) : undefined, customerId: customer || undefined, limit: 500 } }],
    ['trace', 'verdict'],
  );
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };
  const rows = traces.data;

  return (
    <>
      <PageHead title="Traces">
        A run is one model or tool call, a trace is everything the agent did to answer one message, and a thread is one whole conversation. Traces are the evidence
        every other stage works from: the judge reads them, diagnosis clusters them, and the eval suite borrows its realistic inputs from them.
      </PageHead>
      <Layer title="Where traces come from" aside="Click a source to see its traces in the Explorer">
        <TraceSources selected={source} />
      </Layer>
      <Layer title="Explorer" aside={rows ? `${rows.length} traces` : undefined}>
        <div className="hc-filters">
          <label className="hc-field">
            Source
            <select className="hc-select" value={source} onChange={(e) => set('source', e.target.value)}>
              <option value="">All customer traffic</option>
              <optgroup label="Customer traffic">
                {liveSources.map((s) => (
                  <option key={s} value={s}>
                    {sourceWord[s]}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Sandbox, never touches the live shop">
                {sandboxSources.map((s) => (
                  <option key={s} value={s}>
                    {sourceWord[s]}
                  </option>
                ))}
              </optgroup>
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
        <p className="hc-muted" style={{ margin: '10px 0 0', fontSize: 12.5 }}>
          Traces the healer makes in its own sandbox (eval runs, red team probes and router replays) are kept out of customer traffic. Pick one in Source to see them.
        </p>
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
  const { hash } = useLocation();
  const loaded = q.data !== undefined;
  useEffect(() => {
    if (loaded && hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [loaded, hash]);

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
                <dd>{verdict ? <Link to={{ hash: 'verdict' }}><VerdictBadge state={verdict.passed ? 'pass' : 'fail'} /></Link> : <VerdictBadge state="pending" />}</dd>
                <dt>Customer rating</dt>
                <dd>
                  <RatingMark rating={rating} />
                </dd>
                <dt>Customer</dt>
                <dd>{name(trace.customerId)}</dd>
                <dt>Source</dt>
                <dd>{sourceWord[trace.source]}</dd>
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
          <Layer title="Route through the agent graph" aside="Every node and tool this version has, with the path this trace took through them">
            <TraceRoute trace={trace} />
          </Layer>
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
            id="verdict"
            title="Verdict"
            aside={
              <button type="button" className="hc-btn" disabled={rejudge.busy} onClick={() => rejudge.run(async () => { await call('POST /api/healer/traces/:id/judge', { params: { id: trace.id } }); q.reload(); })}>
                {rejudge.busy ? 'Judging…' : 'Judge again'}
              </button>
            }
          >
            <ActionError error={rejudge.error} />
            {verdict ? (
              <>
                <CheckList checks={verdict.checks} />
                <AskedToRefund request={verdict.refundRequest} before={trace.envBefore} />
                <div className="hc-panel" style={{ marginTop: 10 }}>
                  <h3>Whether the customer asked to cancel</h3>
                  <p className={verdict.cancelRequest ? undefined : 'hc-muted'} style={{ margin: 0 }}>
                    {verdict.cancelRequest ? 'The judge read a request to cancel an order.' : 'No request to cancel an order was read from this conversation.'}
                  </p>
                  <p className="hc-sub" style={{ margin: '6px 0 0' }}>
                    Read by the judge on the same call. It checks nothing here: the router's dataset uses it, with the refund request above, to label a request
                    as needing the strong tier when no replay attempted a refund or a cancellation.
                  </p>
                </div>
              </>
            ) : (
              <Empty>Not judged yet. The judge runs on every trace shortly after it arrives, or use Judge again.</Empty>
            )}
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

function AskedToRefund({ request, before }: { request: RefundRequest | null; before: EnvSnapshot }) {
  const unknown = request
    ? request.orders.flatMap((r) => {
        const order = before.orders.find((o) => o.id === r.orderId);
        return order ? r.items.filter((i) => !order.items.some((x) => x.sku === i.sku)).map((i) => `${i.sku} on ${r.orderId}`) : [r.orderId];
      })
    : [];
  return (
    <div className="hc-panel" style={{ marginTop: 10 }}>
      <h3>What the customer asked to refund</h3>
      {request ? (
        <>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {request.orders.map((r) => {
              const order = before.orders.find((o) => o.id === r.orderId);
              return (
                <li key={r.orderId}>
                  <span className="mono">{r.orderId}</span>:{' '}
                  {r.items.length
                    ? r.items.map((i) => `${i.qty} x ${order?.items.find((x) => x.sku === i.sku)?.name ?? i.sku}`).join(', ')
                    : 'no items'}
                </li>
              );
            })}
          </ul>
          <p className="hc-muted" style={{ margin: '6px 0 0' }}>
            {request.goAhead ? 'The customer said to go ahead without checking back.' : 'The customer did not say to go ahead.'}
          </p>
          {unknown.length > 0 && (
            <p style={{ margin: '6px 0 0' }}>
              The judge named {unknown.join(', ')}, which {unknown.length > 1 ? 'are' : 'is'} not in the records, so the owed-refund check was not applied.
            </p>
          )}
        </>
      ) : (
        <p className="hc-muted" style={{ margin: 0 }}>No request for money back was read from this conversation.</p>
      )}
      <p className="hc-sub" style={{ margin: '6px 0 0' }}>
        This is the one part of the owed-refund check that comes from a model: the judge reads the request, and code works out what was owed. If the judge leaves an item
        out, the amount owed is understated and a short refund can pass; if it adds one, a correct refund can fail. Items whose return depends on a condition the customer
        set are left out, so a refund that ignores the condition is not caught.
      </p>
    </div>
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
