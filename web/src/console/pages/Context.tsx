import type { AgentVersion, MemoryNote } from '@healer/agent';
import { useApi } from '../../lib/hooks.ts';
import { dateTime } from '../../lib/format.ts';
import { useConsole } from '../stream.tsx';
import { Empty, Q } from '../components/States.tsx';
import { useCustomers } from '../components/TraceTable.tsx';
import { LineDiff } from '../components/VersionDiff.tsx';
import { IdLink, Layer, PageHead, RawRun, ScopeTag } from '../components/ui.tsx';

type NoteEvent = { version: AgentVersion; kind: 'added' | 'edited' | 'removed'; note: MemoryNote; before?: string };

function history(versions: AgentVersion[]): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const v of versions) {
    const parent = versions.find((p) => p.id === v.parentId);
    const prev = parent?.context ?? [];
    for (const n of v.context) {
      const old = prev.find((p) => p.id === n.id);
      if (!old) out.push({ version: v, kind: 'added', note: n });
      else if (old.text !== n.text) out.push({ version: v, kind: 'edited', note: n, before: old.text });
    }
    for (const n of prev) if (!v.context.some((c) => c.id === n.id)) out.push({ version: v, kind: 'removed', note: n });
  }
  return out.reverse();
}

export function ContextPage() {
  const { overview } = useConsole();
  const versions = useApi('GET /api/healer/versions', [], ['version']);
  const traces = useApi('GET /api/healer/traces', [{ query: { limit: 1 } }], ['trace']);
  const latestId = traces.data?.[0]?.id;
  const latest = useApi('GET /api/healer/traces/:id', [{ params: { id: latestId ?? '' } }], [], latestId !== undefined);
  const { name } = useCustomers();
  const live = versions.data?.find((v) => v.id === overview?.liveVersionId) ?? versions.data?.find((v) => v.status === 'live');
  const loadRun = latest.data?.trace.runs.find((r) => r.name === 'assemble_context');

  const groups = new Map<string, MemoryNote[]>();
  for (const n of live?.context ?? []) {
    const k = n.scope.kind === 'shop' ? 'shop' : n.scope.customerId;
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'shop' ? -1 : b === 'shop' ? 1 : name(a).localeCompare(name(b))));

  return (
    <>
      <PageHead title="Context" accent="var(--context)">
        Context is the text the agent reads before it answers: notes and memory. Changing it is cheap and instant, and it can be scoped to one customer or to the
        whole shop. The hard part is choosing what to remember, what not to remember, and how, because notes pile up, contradict each other and go stale.
      </PageHead>
      <Layer title="Notes in the live version" aside={live ? <>Version <IdLink kind="version" id={live.id} /></> : undefined}>
        <Q q={versions} what="versions">
          {() =>
            !keys.length ? (
              <Empty>The live version has no notes. Approve a context proposal, or write one by hand on the propose page, and notes appear here by scope.</Empty>
            ) : (
              <div className="hc-stack">
                {keys.map((k) => (
                  <div key={k} className="hc-panel">
                    <h3>{k === 'shop' ? 'Shop-wide' : `Customer: ${name(k)}`}</h3>
                    <table className="hc-table">
                      <tbody>
                        {groups.get(k)!.map((n) => (
                          <tr key={n.id}>
                            <td className="mono hc-muted" style={{ width: 90 }}>
                              {n.id}
                            </td>
                            <td>{n.text}</td>
                            <td style={{ width: 140 }}>
                              Added in <IdLink kind="version" id={n.addedInVersion} />
                            </td>
                            <td style={{ width: 130 }}>{n.issueId ? <IdLink kind="issue" id={n.issueId} /> : <span className="hc-muted">no issue</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )
          }
        </Q>
      </Layer>
      <Layer title="History" aside="Every note change across versions, newest first">
        <Q q={versions} what="versions">
          {(vs) => {
            const events = history(vs);
            return events.length ? (
              <table className="hc-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Change</th>
                    <th>Scope</th>
                    <th>Note</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={i}>
                      <td>
                        <IdLink kind="version" id={e.version.id} /> <span className="hc-muted">{e.version.status}</span>
                      </td>
                      <td>
                        <span className={`hc-verdict ${e.kind === 'added' ? 'pass' : e.kind === 'removed' ? 'fail' : ''}`}>{e.kind === 'added' ? 'Added' : e.kind === 'removed' ? 'Removed' : 'Edited'}</span>
                      </td>
                      <td>
                        <ScopeTag scope={e.note.scope} name={name} />
                      </td>
                      <td>{e.before !== undefined ? <LineDiff before={e.before} after={e.note.text} /> : <><span className="mono hc-muted">{e.note.id}</span> {e.note.text}</>}</td>
                      <td className="hc-muted">{dateTime(e.version.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No version has changed the notes yet.</Empty>
            );
          }}
        </Q>
      </Layer>
      <Layer
        title="Raw workings"
        aside={
          latest.data
            ? `How notes reached the agent in the latest conversation, ${latest.data.trace.id}, answered by version ${latest.data.trace.versionId}${latest.data.trace.versionId !== live?.id ? '. It ran before the live version, so newer notes are not in it' : ''}`
            : undefined
        }
        raw
      >
        {loadRun ? <RawRun run={loadRun} title="assemble_context: the system prompt as the model received it" open /> : <Empty>Once a conversation arrives, the exact notes loaded for it are shown here.</Empty>}
      </Layer>
    </>
  );
}
