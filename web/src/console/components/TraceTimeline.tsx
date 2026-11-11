import { Fragment, useState } from 'react';
import type { Run, ToolCallRecord } from '@healer/agent';
import { int, ms, usd } from '../../lib/format.ts';
import { Json } from './ui.tsx';
import { guardLabel } from './VersionDiff.tsx';

function order(runs: Run[]): { run: Run; depth: number }[] {
  const byParent = new Map<string | null, Run[]>();
  for (const r of runs) {
    const k = r.parentId && runs.some((x) => x.id === r.parentId) ? r.parentId : null;
    byParent.set(k, [...(byParent.get(k) ?? []), r]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const out: { run: Run; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of byParent.get(parent) ?? []) {
      out.push({ run: r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function TraceTimeline({ runs, toolCalls }: { runs: Run[]; toolCalls: ToolCallRecord[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!runs.length) return <p className="hc-muted">This trace recorded no steps.</p>;
  const rows = order(runs);
  const t0 = Math.min(...runs.map((r) => new Date(r.startedAt).getTime()));
  const t1 = Math.max(...runs.map((r) => new Date(r.endedAt).getTime()));
  const span = Math.max(t1 - t0, 1);
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="hc-tl" role="list">
      {rows.map(({ run, depth }) => {
        const left = ((new Date(run.startedAt).getTime() - t0) / span) * 100;
        const width = ((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / span) * 100;
        const tc = toolCalls.find((t) => t.runId === run.id);
        const isOpen = open.has(run.id);
        return (
          <Fragment key={run.id}>
            <button type="button" className="hc-tl-row" role="listitem" aria-expanded={isOpen} onClick={() => toggle(run.id)}>
              <span className="hc-tl-name" style={{ paddingLeft: depth * 16 }}>
                <span className="hc-tl-kind">{run.kind}</span>
                <span className={run.kind === 'node' ? undefined : 'mono'}>{run.name}</span>
                {run.model && <span className="hc-muted mono">{run.model}</span>}
                {tc?.blockedByGuard && <span className="hc-verdict fail">blocked</span>}
                {run.error && <span className="hc-verdict fail">error</span>}
              </span>
              <span className="hc-tl-track">
                <span className={`hc-tl-bar ${run.kind}${run.error || tc?.blockedByGuard ? ' err' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} />
              </span>
              <span className="mono hc-muted" style={{ textAlign: 'right' }}>
                {ms(run.startedAt, run.endedAt)}
              </span>
              <span className="mono hc-muted" style={{ textAlign: 'right' }}>
                {run.usage ? usd(run.usage.costUsd) : ''}
              </span>
            </button>
            {isOpen && (
              <div className="hc-tl-detail">
                {run.usage && (
                  <p className="hc-muted" style={{ margin: '0 0 6px' }}>
                    {int(run.usage.inputTokens)} input tokens, {int(run.usage.outputTokens)} output tokens, {usd(run.usage.costUsd)}. Role {run.role ?? 'none'}.
                  </p>
                )}
                {tc?.blockedByGuard && <p className="hc-error">Blocked by the guard: {guardLabel(tc.blockedByGuard)}.</p>}
                {run.error && <p className="hc-error">{run.error}</p>}
                <div className="hc-raw-body" style={{ padding: 0 }}>
                  <div>
                    <h4>Exact input</h4>
                    <Json value={run.input} />
                  </div>
                  <div>
                    <h4>Exact output</h4>
                    <Json value={run.output} />
                  </div>
                </div>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
