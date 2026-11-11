import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { AgentVersion, Change, Effort, Guards, Proposal, RouterModel, Tier, ToolName } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime, tierName } from '../../lib/format.ts';
import { useConsole } from '../stream.tsx';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { useCustomers } from '../components/TraceTable.tsx';
import { ChangeSummary, VersionDiff, guardLabel } from '../components/VersionDiff.tsx';
import { IdLink, JobProgress, Layer, LineageStrip, PageHead, RawRun, SurfaceTag, Tag, VerdictBadge, humanize } from '../components/ui.tsx';
import { AutonomyPanel } from './Home.tsx';

const explainer =
  'What do we change, and for whom? A proposal is a candidate version: the live version plus changes to its context, harness or model, scoped to one customer or the whole shop. The working rule is to fix at the cheapest surface that solves the problem, and nothing reaches customers until the gate has run.';

const statusWord: Record<Proposal['status'], string> = {
  draft: 'Draft',
  gating: 'Gate running',
  awaiting_approval: 'Awaiting approval',
  rejected: 'Rejected by the gate',
  promoted: 'Promoted',
  discarded: 'Discarded',
};

export function ProposalStatus({ status }: { status: Proposal['status'] }) {
  if (status === 'promoted') return <VerdictBadge state="pass" label={statusWord[status]} />;
  if (status === 'rejected') return <VerdictBadge state="fail" label={statusWord[status]} />;
  return <Tag>{statusWord[status]}</Tag>;
}

function surfacesOf(p: Proposal) {
  return [...new Set(p.changes.map((c) => c.surface))];
}

export function ProposePage() {
  const proposals = useApi('GET /api/healer/proposals', [], ['proposal', 'gateRun']);
  const customers = useCustomers().list;
  const latestWithRun = proposals.data?.find((p) => p.proposeRun);
  const queue = proposals.data?.filter((p) => p.status === 'awaiting_approval') ?? [];

  return (
    <>
      <PageHead title="Propose">{explainer}</PageHead>
      <div className="hc-cols" style={{ gridTemplateColumns: 'minmax(0,1fr) 320px' }}>
        <Layer title="Approval queue" aside={`${queue.length} waiting`}>
          <Q q={proposals} what="proposals">
            {() =>
              queue.length ? (
                <div className="hc-stack">
                  {queue.map((p) => (
                    <QueueItem key={p.id} p={p} onDone={proposals.reload} />
                  ))}
                </div>
              ) : (
                <Empty>Nothing is waiting. When the gate accepts a candidate and autonomy is set to approve, it waits here for you.</Empty>
              )
            }
          </Q>
        </Layer>
        <div style={{ marginTop: 28 }}>
          <AutonomyPanel />
        </div>
      </div>
      <Layer title="All proposals">
        <Q q={proposals} what="proposals">
          {(list) =>
            list.length ? (
              <table className="hc-table">
                <thead>
                  <tr>
                    <th>Proposal</th>
                    <th>Title</th>
                    <th>Surface</th>
                    <th>Author</th>
                    <th>Issue</th>
                    <th>Versions</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <IdLink kind="proposal" id={p.id} />
                      </td>
                      <td>{p.title}</td>
                      <td>
                        <span className="hc-row">
                          {surfacesOf(p).map((s) => (
                            <SurfaceTag key={s} surface={s} />
                          ))}
                        </span>
                      </td>
                      <td>{p.author === 'loop' ? 'Loop' : 'Human'}</td>
                      <td>{p.issueId ? <IdLink kind="issue" id={p.issueId} /> : <span className="hc-muted">none</span>}</td>
                      <td>
                        <IdLink kind="version" id={p.baseVersionId} /> to <IdLink kind="version" id={p.candidateVersionId} />
                      </td>
                      <td>
                        <ProposalStatus status={p.status} />
                      </td>
                      <td className="hc-muted">{dateTime(p.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No proposals yet. Propose a fix from an issue, or write one by hand below.</Empty>
            )
          }
        </Q>
      </Layer>
      <Layer title="Write a proposal by hand">
        <ProposalEditor customers={customers} />
      </Layer>
      <Layer title="Raw workings" aside={latestWithRun ? `Proposal call behind ${latestWithRun.id}` : undefined} raw>
        {latestWithRun?.proposeRun ? <RawRun run={latestWithRun.proposeRun} title="Propose" open /> : <Empty>The exact proposal prompt and response appear here after the loop drafts its first fix.</Empty>}
      </Layer>
    </>
  );
}

function QueueItem({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const act = useAction();
  return (
    <div className="hc-panel">
      <div className="hc-row">
        <IdLink kind="proposal" id={p.id} />
        <strong>{p.title}</strong>
        {surfacesOf(p).map((s) => (
          <SurfaceTag key={s} surface={s} />
        ))}
        <span className="hc-spacer" />
        {p.gateRunId && (
          <span className="hc-muted">
            Gate <IdLink kind="gateRun" id={p.gateRunId} />
          </span>
        )}
      </div>
      <p className="hc-sub" style={{ margin: '6px 0 10px' }}>
        {p.rationale}
      </p>
      <div className="hc-row">
        <button type="button" className="hc-btn primary" disabled={act.busy} onClick={() => act.run(async () => { await call('POST /api/healer/proposals/:id/approve', { params: { id: p.id } }); onDone(); })}>
          Approve and deploy
        </button>
        <button type="button" className="hc-btn" disabled={act.busy} onClick={() => act.run(async () => { await call('POST /api/healer/proposals/:id/discard', { params: { id: p.id } }); onDone(); })}>
          Discard
        </button>
      </div>
      <ActionError error={act.error} />
    </div>
  );
}

export function ProposalPage() {
  const { id = '' } = useParams();
  const q = useApi('GET /api/healer/proposals/:id', [{ params: { id } }], ['proposal', 'gateRun', 'version']);
  const { list: customers } = useCustomers();
  const { jobs, trackJob } = useConsole();
  const act = useAction();

  return (
    <Q q={q} what="the proposal">
      {({ proposal: p, base, candidate, gateRun, lineage }) => {
        const job = jobs.find((j) => j.kind === 'gate' && j.refId === p.id && (j.status === 'running' || p.status === 'gating'));
        const canGate = p.status === 'draft' || p.status === 'rejected';
        const canApprove = p.status === 'awaiting_approval';
        const canDiscard = p.status !== 'promoted' && p.status !== 'discarded';
        return (
          <>
            <PageHead title={p.title} crumb={<><Link to="/console/propose">Propose</Link> <span className="mono">{p.id}</span></>}>
              {explainer}
            </PageHead>
            <LineageStrip lineage={lineage} self={{ kind: 'proposal', id: p.id }} />
            <div className="hc-cols">
              <div className="hc-panel">
                <h3>Proposal</h3>
                <p style={{ marginTop: 0 }}>{p.rationale}</p>
                <dl className="hc-kv">
                  <dt>Status</dt>
                  <dd>
                    <ProposalStatus status={p.status} />
                  </dd>
                  <dt>Author</dt>
                  <dd>{p.author === 'loop' ? 'The loop' : 'A human, in the console'}</dd>
                  <dt>Issue</dt>
                  <dd>{p.issueId ? <IdLink kind="issue" id={p.issueId} /> : <span className="hc-muted">none</span>}</dd>
                  <dt>Base version</dt>
                  <dd>
                    <IdLink kind="version" id={p.baseVersionId} />
                  </dd>
                  <dt>Candidate</dt>
                  <dd>
                    <IdLink kind="version" id={p.candidateVersionId} /> <span className="hc-muted">{humanize(candidate.status)}</span>
                  </dd>
                  <dt>Created</dt>
                  <dd>{dateTime(p.createdAt)}</dd>
                </dl>
              </div>
              <div className="hc-panel">
                <h3>Gate</h3>
                {gateRun ? (
                  <dl className="hc-kv">
                    <dt>Gate run</dt>
                    <dd>
                      <IdLink kind="gateRun" id={gateRun.id} />
                    </dd>
                    <dt>Decision</dt>
                    <dd>{gateRun.decision === 'pending' ? <VerdictBadge state="pending" label="Running" /> : <VerdictBadge state={gateRun.decision === 'accept' ? 'pass' : 'fail'} label={gateRun.decision === 'accept' ? 'Accepted' : 'Rejected'} />}</dd>
                    <dt>Fixed</dt>
                    <dd>{gateRun.fixedCaseIds.length ? gateRun.fixedCaseIds.map((c) => <div key={c}><IdLink kind="evalCase" id={c} /></div>) : <span className="hc-muted">none</span>}</dd>
                    <dt>Regressed</dt>
                    <dd>{gateRun.regressedCaseIds.length ? gateRun.regressedCaseIds.map((c) => <div key={c}><IdLink kind="evalCase" id={c} /></div>) : <span className="hc-muted">none</span>}</dd>
                  </dl>
                ) : (
                  <p className="hc-muted" style={{ marginTop: 0 }}>The gate has not run on this candidate yet.</p>
                )}
                {job && (
                  <div style={{ marginTop: 10 }}>
                    <JobProgress job={job} />
                  </div>
                )}
                <div className="hc-row" style={{ marginTop: 12 }}>
                  <button type="button" className="hc-btn" disabled={act.busy || !canGate} onClick={() => act.run(async () => trackJob(await call('POST /api/healer/proposals/:id/gate', { params: { id: p.id } })))}>
                    Run the gate
                  </button>
                  <button type="button" className="hc-btn primary" disabled={act.busy || !canApprove} onClick={() => act.run(async () => { await call('POST /api/healer/proposals/:id/approve', { params: { id: p.id } }); q.reload(); })}>
                    Approve and deploy
                  </button>
                  <button type="button" className="hc-btn" disabled={act.busy || !canDiscard} onClick={() => act.run(async () => { await call('POST /api/healer/proposals/:id/discard', { params: { id: p.id } }); q.reload(); })}>
                    Discard
                  </button>
                </div>
                <ActionError error={act.error} />
              </div>
            </div>
            <Layer title="Changes" aside={`${p.changes.length} change${p.changes.length === 1 ? '' : 's'}`}>
              <ul className="hc-checks">
                {p.changes.map((c, i) => (
                  <li key={i} style={{ gridTemplateColumns: '84px 1fr' }}>
                    <SurfaceTag surface={c.surface} />
                    <ChangeSummary change={c} customers={customers} />
                  </li>
                ))}
              </ul>
            </Layer>
            <Layer title="Base against candidate">
              <VersionDiff base={base} candidate={candidate} customers={customers} />
            </Layer>
            <Layer title="Raw workings" raw>
              {p.proposeRun ? <RawRun run={p.proposeRun} title="Propose" open /> : <Empty>This proposal was written by hand, so there is no proposal call to show.</Empty>}
              <details className="hc-raw" style={{ marginTop: 8 }}>
                <summary>
                  <strong>Changes as sent</strong>
                  <span className="meta">exact JSON</span>
                </summary>
                <div style={{ padding: '0 12px 12px' }}>
                  <pre className="hc-pre">{JSON.stringify(p.changes, null, 2)}</pre>
                </div>
              </details>
            </Layer>
          </>
        );
      }}
    </Q>
  );
}

// ── Editor ────────────────────────────────────────────────────────────────

type Kind = 'add_note' | 'edit_note' | 'remove_note' | 'prompt' | 'tool' | 'guards' | 'model';
const kindWord: Record<Kind, string> = {
  add_note: 'Add a context note',
  edit_note: 'Edit a context note',
  remove_note: 'Remove a context note',
  prompt: 'Edit the system prompt',
  tool: 'Change a tool',
  guards: 'Set guards',
  model: 'Set the model config',
};
const tiers: Tier[] = ['haiku', 'sonnet', 'opus'];
const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function ProposalEditor({ customers }: { customers: { id: string; name: string }[] }) {
  const { overview } = useConsole();
  const liveId = overview?.liveVersionId;
  const live = useApi('GET /api/healer/versions/:id', [{ params: { id: liveId ?? 0 } }], ['version'], liveId !== undefined);
  const model = useApi('GET /api/healer/model', [], ['version']);
  const [title, setTitle] = useState('');
  const [rationale, setRationale] = useState('');
  const [changes, setChanges] = useState<Change[]>([]);
  const [kind, setKind] = useState<Kind>('add_note');
  const [formKey, setFormKey] = useState(0);
  const act = useAction();
  const navigate = useNavigate();

  if (!live.data) return <p className="hc-muted">{live.error ? 'The live version could not be loaded, so there is nothing to edit against.' : 'Loading the live version…'}</p>;
  const v = live.data.version;

  return (
    <div className="hc-cols">
      <div className="hc-panel hc-stack">
        <p className="hc-muted" style={{ margin: 0 }}>
          Changes apply on top of the live version, <IdLink kind="version" id={v.id} />. Saving creates a draft; run the gate from its page.
        </p>
        <label className="hc-field">
          Change to add
          <select className="hc-select" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(kindWord) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {kindWord[k]}
              </option>
            ))}
          </select>
        </label>
        <ChangeForm key={`${kind}-${formKey}`} kind={kind} version={v} customers={customers} routers={model.data?.routers ?? []} onAdd={(c) => {
            setChanges((list) => [...list, c]);
            setFormKey((k) => k + 1);
          }} />
      </div>
      <div className="hc-panel hc-stack">
        <label className="hc-field">
          Title
          <input className="hc-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Say what the change does" />
        </label>
        <label className="hc-field">
          Rationale
          <textarea className="hc-textarea" rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Why this change, and why this surface" style={{ fontFamily: 'inherit' }} />
        </label>
        <div>
          <div className="hc-field" style={{ marginBottom: 4 }}>
            Changes
          </div>
          {changes.length ? (
            <ul className="hc-checks">
              {changes.map((c, i) => (
                <li key={i} style={{ gridTemplateColumns: '84px 1fr auto' }}>
                  <SurfaceTag surface={c.surface} />
                  <ChangeSummary change={c} customers={customers} />
                  <button type="button" className="hc-btn" onClick={() => setChanges((l) => l.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hc-muted" style={{ margin: 0 }}>
              No changes yet. Build one on the left and add it.
            </p>
          )}
        </div>
        <div className="hc-row">
          <button
            type="button"
            className="hc-btn primary"
            disabled={act.busy || !title.trim() || !changes.length}
            onClick={() =>
              act.run(async () => {
                const p = await call('POST /api/healer/proposals', { body: { title: title.trim(), rationale: rationale.trim(), changes } });
                navigate(`/console/proposals/${p.id}`);
              })
            }
          >
            Save as draft proposal
          </button>
        </div>
        <ActionError error={act.error} />
      </div>
    </div>
  );
}

function ChangeForm({ kind, version, customers, routers, onAdd }: { kind: Kind; version: AgentVersion; customers: { id: string; name: string }[]; routers: RouterModel[]; onAdd: (c: Change) => void }) {
  const [scope, setScope] = useState('shop');
  const [text, setText] = useState('');
  const [noteId, setNoteId] = useState(version.context[0]?.id ?? '');
  const [prompt, setPrompt] = useState(version.harness.systemPrompt);
  const [tool, setTool] = useState<ToolName>(version.harness.tools[0]?.name ?? 'get_order');
  const toolCfg = version.harness.tools.find((t) => t.name === tool);
  const [toolDesc, setToolDesc] = useState(toolCfg?.description ?? '');
  const [toolOn, setToolOn] = useState(toolCfg?.enabled ?? true);
  const [guards, setGuards] = useState<Guards>(version.harness.guards);
  const live = version.model;
  const [mode, setMode] = useState<'fixed' | 'routed'>(live.mode);
  const [tier, setTier] = useState<Tier>(live.mode === 'fixed' ? live.tier : 'sonnet');
  const [effort, setEffort] = useState<Effort>(live.effort);
  const [easy, setEasy] = useState<Tier>(live.mode === 'routed' ? live.easyTier : 'haiku');
  const [hard, setHard] = useState<Tier>(live.mode === 'routed' ? live.hardTier : 'sonnet');
  const [routerId, setRouterId] = useState(routers.at(-1)?.id ?? '');

  const add = (
    <button
      type="button"
      className="hc-btn"
      onClick={() => {
        const c = build();
        if (c) onAdd(c);
      }}
    >
      Add this change
    </button>
  );

  function build(): Change | null {
    switch (kind) {
      case 'add_note':
        return text.trim() ? { surface: 'context', op: 'add', scope: scope === 'shop' ? { kind: 'shop' } : { kind: 'customer', customerId: scope }, text: text.trim() } : null;
      case 'edit_note':
        return noteId && text.trim() ? { surface: 'context', op: 'edit', noteId, text: text.trim() } : null;
      case 'remove_note':
        return noteId ? { surface: 'context', op: 'remove', noteId } : null;
      case 'prompt':
        return { surface: 'harness', op: 'set_system_prompt', systemPrompt: prompt };
      case 'tool':
        return { surface: 'harness', op: 'set_tool', name: tool, description: toolDesc, enabled: toolOn };
      case 'guards':
        return { surface: 'harness', op: 'set_guards', guards };
      case 'model': {
        if (mode === 'fixed') return { surface: 'model', op: 'set_model', model: { mode: 'fixed', tier, effort } };
        const router = routers.find((r) => r.id === routerId);
        return router ? { surface: 'model', op: 'set_model', model: { mode: 'routed', easyTier: easy, hardTier: hard, effort, router } } : null;
      }
    }
  }

  const tierSelect = (value: Tier, set: (t: Tier) => void, label: string) => (
    <label className="hc-field">
      {label}
      <select className="hc-select" value={value} onChange={(e) => set(e.target.value as Tier)}>
        {tiers.map((t) => (
          <option key={t} value={t}>
            {tierName[t]}
          </option>
        ))}
      </select>
    </label>
  );

  switch (kind) {
    case 'add_note':
      return (
        <>
          <label className="hc-field">
            Scope
            <select className="hc-select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="shop">Shop-wide</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  Customer: {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="hc-field">
            Note
            <textarea className="hc-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          {add}
        </>
      );
    case 'edit_note':
    case 'remove_note':
      if (!version.context.length) return <p className="hc-muted">The live version has no notes yet.</p>;
      return (
        <>
          <label className="hc-field">
            Note
            <select
              className="hc-select"
              value={noteId}
              onChange={(e) => {
                setNoteId(e.target.value);
                setText(version.context.find((n) => n.id === e.target.value)?.text ?? '');
              }}
            >
              {version.context.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.id}: {n.text.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
          {kind === 'edit_note' && (
            <label className="hc-field">
              New text
              <textarea className="hc-textarea" rows={3} value={text} placeholder={version.context.find((n) => n.id === noteId)?.text} onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          {add}
        </>
      );
    case 'prompt':
      return (
        <>
          <label className="hc-field">
            System prompt
            <textarea className="hc-textarea" rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          {add}
        </>
      );
    case 'tool':
      return (
        <>
          <label className="hc-field">
            Tool
            <select
              className="hc-select"
              value={tool}
              onChange={(e) => {
                const t = version.harness.tools.find((x) => x.name === e.target.value);
                setTool(e.target.value as ToolName);
                setToolDesc(t?.description ?? '');
                setToolOn(t?.enabled ?? true);
              }}
            >
              {version.harness.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="hc-field">
            Description the model sees
            <textarea className="hc-textarea" rows={3} value={toolDesc} onChange={(e) => setToolDesc(e.target.value)} />
          </label>
          <label className="hc-row" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={toolOn} onChange={(e) => setToolOn(e.target.checked)} /> Enabled
          </label>
          {add}
        </>
      );
    case 'guards':
      return (
        <>
          <label className="hc-row" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={guards.requireOrderLookupBeforeWrite} onChange={(e) => setGuards({ ...guards, requireOrderLookupBeforeWrite: e.target.checked })} />
            {guardLabel('requireOrderLookupBeforeWrite')}
          </label>
          <label className="hc-row" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={guards.blockDuplicateRefund} onChange={(e) => setGuards({ ...guards, blockDuplicateRefund: e.target.checked })} />
            {guardLabel('blockDuplicateRefund')}
          </label>
          <label className="hc-field">
            Escalate refunds above this amount in dollars (empty for off)
            <input
              className="hc-input"
              type="number"
              min={0}
              value={guards.refundEscalationThreshold ?? ''}
              onChange={(e) => setGuards({ ...guards, refundEscalationThreshold: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </label>
          {add}
        </>
      );
    case 'model':
      return (
        <>
          <span className="hc-seg">
            <button type="button" aria-pressed={mode === 'fixed'} onClick={() => setMode('fixed')}>
              One tier
            </button>
            <button type="button" aria-pressed={mode === 'routed'} onClick={() => setMode('routed')}>
              Routed
            </button>
          </span>
          {mode === 'fixed' ? (
            tierSelect(tier, setTier, 'Tier')
          ) : (
            <>
              {tierSelect(easy, setEasy, 'Tier for easy requests')}
              {tierSelect(hard, setHard, 'Tier for hard requests')}
              <label className="hc-field">
                Router weights
                <select className="hc-select" value={routerId} onChange={(e) => setRouterId(e.target.value)}>
                  {routers.length === 0 && <option value="">No router trained yet</option>}
                  {routers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id}, validation accuracy {(r.metrics.valAccuracy * 100).toFixed(0)}%
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="hc-field">
            Effort
            <select className="hc-select" value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
              {efforts.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          {add}
        </>
      );
  }
}
