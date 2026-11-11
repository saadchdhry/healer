import type { AgentVersion, Change, Guards, ModelConfig } from '@healer/agent';

type Named = { id: string; name: string };
import { modelLabel } from '../../lib/format.ts';
import { IdLink, ScopeTag, SurfaceTag } from './ui.tsx';

type Line = { kind: 'add' | 'del' | 'same'; text: string };

export function lineDiff(a: string, b: string): Line[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'del', text: x[i++]! });
    else out.push({ kind: 'add', text: y[j++]! });
  }
  while (i < n) out.push({ kind: 'del', text: x[i++]! });
  while (j < m) out.push({ kind: 'add', text: y[j++]! });
  return out;
}

export function LineDiff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="hc-diff">
      {lineDiff(before, after).map((l, i) => (
        <div key={i} className={l.kind}>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

const guardWord: Record<keyof Guards, string> = {
  requireOrderLookupBeforeWrite: 'Require order lookup before any write',
  blockDuplicateRefund: 'Block duplicate refunds',
  refundEscalationThreshold: 'Escalate refunds above',
};

export function guardValue(k: keyof Guards, v: Guards[keyof Guards]): string {
  if (k === 'refundEscalationThreshold') return v === null ? 'off' : `$${v}`;
  return v ? 'on' : 'off';
}

export function guardLabel(k: keyof Guards): string {
  return guardWord[k];
}

function modelEqual(a: ModelConfig, b: ModelConfig) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function VersionDiff({ base, candidate, customers = [] }: { base: AgentVersion; candidate: AgentVersion; customers?: Named[] }) {
  const name = (id: string) => customers.find((c) => c.id === id)?.name ?? id;
  const added = candidate.context.filter((n) => !base.context.some((b) => b.id === n.id));
  const removed = base.context.filter((n) => !candidate.context.some((c) => c.id === n.id));
  const edited = candidate.context.filter((n) => base.context.some((b) => b.id === n.id && b.text !== n.text));
  const promptChanged = base.harness.systemPrompt !== candidate.harness.systemPrompt;
  const tools = candidate.harness.tools
    .map((t) => ({ t, b: base.harness.tools.find((x) => x.name === t.name) }))
    .filter(({ t, b }) => !b || b.description !== t.description || b.enabled !== t.enabled);
  const guards = (Object.keys(candidate.harness.guards) as (keyof Guards)[]).filter((k) => candidate.harness.guards[k] !== base.harness.guards[k]);
  const stepsChanged = base.harness.maxSteps !== candidate.harness.maxSteps;
  const modelChanged = !modelEqual(base.model, candidate.model);
  const nothing = !added.length && !removed.length && !edited.length && !promptChanged && !tools.length && !guards.length && !stepsChanged && !modelChanged;

  return (
    <div>
      <p className="hc-muted" style={{ marginTop: 0 }}>
        From <IdLink kind="version" id={base.id} /> to <IdLink kind="version" id={candidate.id} />
      </p>
      {nothing && <p className="hc-muted">The two versions are identical.</p>}
      {(added.length > 0 || removed.length > 0 || edited.length > 0) && (
        <div className="hc-change">
          <div>
            <SurfaceTag surface="context" />
          </div>
          <div className="hc-stack" style={{ gap: 6 }}>
            {added.map((n) => (
              <div key={n.id}>
                <div className="hc-row">
                  <span className="hc-verdict pass">Note added</span> <span className="mono hc-muted">{n.id}</span> <ScopeTag scope={n.scope} name={name} />
                </div>
                <pre className="hc-diff">
                  <div className="add">{n.text}</div>
                </pre>
              </div>
            ))}
            {edited.map((n) => (
              <div key={n.id}>
                <div className="hc-row">
                  <span>Note edited</span> <span className="mono hc-muted">{n.id}</span> <ScopeTag scope={n.scope} name={name} />
                </div>
                <LineDiff before={base.context.find((b) => b.id === n.id)!.text} after={n.text} />
              </div>
            ))}
            {removed.map((n) => (
              <div key={n.id}>
                <div className="hc-row">
                  <span className="hc-verdict fail">Note removed</span> <span className="mono hc-muted">{n.id}</span> <ScopeTag scope={n.scope} name={name} />
                </div>
                <pre className="hc-diff">
                  <div className="del">{n.text}</div>
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
      {(promptChanged || tools.length > 0 || guards.length > 0 || stepsChanged) && (
        <div className="hc-change">
          <div>
            <SurfaceTag surface="harness" />
          </div>
          <div className="hc-stack" style={{ gap: 10 }}>
            {promptChanged && (
              <div>
                <div style={{ marginBottom: 4 }}>System prompt</div>
                <LineDiff before={base.harness.systemPrompt} after={candidate.harness.systemPrompt} />
              </div>
            )}
            {tools.map(({ t, b }) => (
              <div key={t.name}>
                <span className="mono">{t.name}</span>
                {b && b.enabled !== t.enabled && <span className={`hc-verdict ${t.enabled ? 'pass' : 'fail'}`}> {t.enabled ? 'enabled' : 'disabled'}</span>}
                {b && b.description !== t.description && <LineDiff before={b.description} after={t.description} />}
                {!b && <span> added</span>}
              </div>
            ))}
            {guards.map((k) => (
              <div key={k}>
                Guard: {guardWord[k]}: <span className="mono">{guardValue(k, base.harness.guards[k])}</span> to{' '}
                <span className="mono">{guardValue(k, candidate.harness.guards[k])}</span>
              </div>
            ))}
            {stepsChanged && (
              <div>
                Maximum steps: <span className="mono">{base.harness.maxSteps}</span> to <span className="mono">{candidate.harness.maxSteps}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {modelChanged && (
        <div className="hc-change">
          <div>
            <SurfaceTag surface="model" />
          </div>
          <div>
            <LineDiff before={modelLabel(base.model)} after={modelLabel(candidate.model)} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ChangeSummary({ change, customers = [] }: { change: Change; customers?: Named[] }) {
  const name = (id: string) => customers.find((c) => c.id === id)?.name ?? id;
  switch (change.op) {
    case 'add':
      return (
        <span>
          Add note <ScopeTag scope={change.scope} name={name} />: {change.text}
        </span>
      );
    case 'edit':
      return (
        <span>
          Edit note <span className="mono">{change.noteId}</span>: {change.text}
        </span>
      );
    case 'remove':
      return (
        <span>
          Remove note <span className="mono">{change.noteId}</span>
        </span>
      );
    case 'set_system_prompt':
      return <span>Replace the system prompt</span>;
    case 'set_tool':
      return (
        <span>
          Change tool <span className="mono">{change.name}</span>
          {change.enabled !== undefined && (change.enabled ? ', enable it' : ', disable it')}
          {change.description !== undefined && ', new description'}
        </span>
      );
    case 'set_guards':
      return (
        <span>
          Set guards:{' '}
          {(Object.entries(change.guards) as [keyof Guards, Guards[keyof Guards]][]).map(([k, v]) => `${guardWord[k]} ${guardValue(k, v)}`).join(', ')}
        </span>
      );
    case 'set_model':
      return <span>Set model to {modelLabel(change.model)}</span>;
  }
}
