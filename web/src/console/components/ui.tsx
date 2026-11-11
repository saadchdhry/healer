import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Cause, CheckResult, Job, Lineage, Ref, RefKind, Run, Scope, Surface } from '@healer/agent';
import { int, ms, usd } from '../../lib/format.ts';

export function refPath(kind: RefKind, id: string): string {
  const e = encodeURIComponent(id);
  switch (kind) {
    case 'trace':
      return `/console/traces/${e}`;
    case 'verdict':
      return `/console/verdicts/${e}`;
    case 'issue':
      return `/console/issues/${e}`;
    case 'proposal':
      return `/console/proposals/${e}`;
    case 'gateRun':
      return `/console/gate/${e}`;
    case 'version':
      return `/console/versions/${e}`;
    case 'evalCase':
      return `/console/evals/${e}`;
    case 'evalRun':
      return `/console/eval-runs/${e}`;
    case 'finding':
      return `/console/findings/${e}`;
  }
}

export function IdLink({ kind, id, children }: { kind: RefKind; id: string | number; children?: ReactNode }) {
  return (
    <Link className="mono" to={refPath(kind, String(id))}>
      {children ?? (kind === 'version' ? `v${id}` : id)}
    </Link>
  );
}

export function CustomerLink({ id, name }: { id: string; name?: string }) {
  return <Link to={`/console/traces?customer=${encodeURIComponent(id)}`}>{name ?? id}</Link>;
}

const glyph = {
  pass: <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />,
  fail: <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  pending: <circle cx="8" cy="8" r="4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeDasharray="2.5 2" />,
};

export function Glyph({ state, size = 14 }: { state: 'pass' | 'fail' | 'pending'; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      {glyph[state]}
    </svg>
  );
}

const verdictWord = { pass: 'Passed', fail: 'Failed', pending: 'Not judged yet' };
export function VerdictBadge({ state, label }: { state: 'pass' | 'fail' | 'pending'; label?: string }) {
  return (
    <span className={`hc-verdict ${state}`}>
      <Glyph state={state} />
      {label ?? verdictWord[state]}
    </span>
  );
}

const surfaceWord: Record<Surface, string> = { context: 'Context', harness: 'Harness', model: 'Model' };
export function SurfaceTag({ surface }: { surface: Surface }) {
  return <span className={`hc-tag ${surface}`}>{surfaceWord[surface]}</span>;
}

const causeWord: Record<Cause, string> = { knowledge: 'Knowledge gap', process: 'Process gap', capability: 'Capability gap' };
const causeSurface: Record<Cause, Surface> = { knowledge: 'context', process: 'harness', capability: 'model' };
export function CauseTag({ cause }: { cause: Cause }) {
  return <span className={`hc-tag ${causeSurface[cause]}`}>{causeWord[cause]}</span>;
}

export function Tag({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span className="hc-tag" style={style}>
      {children}
    </span>
  );
}

export function ScopeTag({ scope, name }: { scope: Scope; name?: (id: string) => string }) {
  return <Tag>{scope.kind === 'shop' ? 'Shop-wide' : `Customer: ${name ? name(scope.customerId) : scope.customerId}`}</Tag>;
}

export function humanize(s: string): string {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function PageHead({ title, crumb, accent, children }: { title: ReactNode; crumb?: ReactNode; accent?: string; children?: ReactNode }) {
  return (
    <header className="hc-page-head" style={accent ? ({ '--accent': accent } as CSSProperties) : undefined}>
      {crumb && <div className="hc-crumb">{crumb}</div>}
      <h1>{title}</h1>
      {children && <p className="hc-explainer">{children}</p>}
    </header>
  );
}

export function Layer({ title, aside, raw, id, children }: { title: ReactNode; aside?: ReactNode; raw?: boolean; id?: string; children: ReactNode }) {
  return (
    <section id={id} className={`hc-layer${raw ? ' hc-raw-layer' : ''}`}>
      <h2>
        {title}
        {aside && <span className="hc-aside">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="hc-pre">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function RawRun({ run, title, open }: { run: Run; title?: string; open?: boolean }) {
  return (
    <details className="hc-raw" open={open}>
      <summary>
        <strong>{title ?? run.name}</strong>
        {run.role && <span className="meta">Role {run.role}</span>}
        {run.model && <span className="meta mono">{run.model}</span>}
        <span className="meta">{ms(run.startedAt, run.endedAt)}</span>
        {run.usage && (
          <span className="meta">
            {int(run.usage.inputTokens)} in, {int(run.usage.outputTokens)} out, {usd(run.usage.costUsd)}
          </span>
        )}
        {run.error && <span className="hc-verdict fail">{run.error}</span>}
      </summary>
      <div className="hc-raw-body">
        <div>
          <h4>Exact request</h4>
          <Json value={run.input} />
        </div>
        <div>
          <h4>Exact response</h4>
          <Json value={run.output} />
        </div>
      </div>
    </details>
  );
}

export function NoRawRun({ children }: { children: ReactNode }) {
  return <p className="hc-muted">{children}</p>;
}

const kindWord: Record<CheckResult['kind'], string> = {
  invariant: 'Policy rule',
  end_state: 'End state',
  tool_sequence: 'Tool sequence',
  exact_match: 'Exact match',
  rubric: 'Rubric',
  feedback: 'Customer rating',
  consistency: 'Consistency',
};
export const checkKindWord = kindWord;

export function CheckList({ checks }: { checks: CheckResult[] }) {
  if (!checks.length) return <p className="hc-muted">No checks applied.</p>;
  return (
    <ul className="hc-checks">
      {checks.map((c, i) => (
        <li key={c.checkId + i}>
          <span className={`hc-verdict ${c.passed ? 'pass' : 'fail'}`} aria-label={c.passed ? 'Passed' : 'Failed'}>
            <Glyph state={c.passed ? 'pass' : 'fail'} />
          </span>
          <div>
            <div className="hc-row">
              <span>{c.label}</span>
              <Tag>{kindWord[c.kind]}</Tag>
            </div>
            <p>{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

const jobRef: Partial<Record<Job['kind'], { kind: RefKind; word: string }>> = {
  gate: { kind: 'proposal', word: 'For proposal' },
  propose: { kind: 'issue', word: 'For issue' },
  eval: { kind: 'evalRun', word: 'Eval run' },
};

export function JobProgress({ job }: { job: Job }) {
  const pctDone = job.progress.total ? (job.progress.done / job.progress.total) * 100 : 0;
  return (
    <div className="hc-job">
      <div className="hc-row">
        <span>{job.label}</span>
        <span className="hc-spacer" />
        <span className="hc-muted mono">
          {job.status === 'running' ? (job.progress.total ? `${job.progress.done} of ${job.progress.total}` : 'starting') : job.status === 'done' ? 'done' : 'failed'}
        </span>
      </div>
      <div className={`hc-bar ${job.status}`} role="progressbar" aria-valuenow={job.progress.done} aria-valuemax={job.progress.total}>
        <span style={{ width: `${job.status === 'failed' ? 100 : pctDone}%` }} />
      </div>
      {job.error && <p className="hc-error" style={{ margin: 0 }}>{job.error}</p>}
      {job.refId && jobRef[job.kind] && (
        <span className="hc-muted">
          {jobRef[job.kind]!.word} <IdLink kind={jobRef[job.kind]!.kind} id={job.refId} />
        </span>
      )}
    </div>
  );
}

const lineageCols: { key: keyof Lineage; label: string }[] = [
  { key: 'traces', label: 'Traces' },
  { key: 'verdicts', label: 'Verdicts' },
  { key: 'issues', label: 'Issue' },
  { key: 'proposals', label: 'Proposals' },
  { key: 'gateRuns', label: 'Gate runs' },
  { key: 'versions', label: 'Versions' },
  { key: 'evalCases', label: 'Eval cases' },
];

function refLabel(r: Ref): string {
  const text = r.kind === 'version' ? r.label.replace(new RegExp(`^v${r.id}:?\\s*`), '') : r.label;
  return text === r.id ? '' : text;
}

export function LineageStrip({ lineage, self }: { lineage: Lineage; self?: { kind: RefKind; id: string } }) {
  return (
    <nav className="hc-lineage" aria-label="Lineage">
      {lineageCols.map((c) => (
        <div key={c.key}>
          <p>{c.label}</p>
          {lineage[c.key].length ? (
            <ul>
              {lineage[c.key].map((r: Ref) => (
                <li key={r.kind + r.id} className={self && self.kind === r.kind && self.id === r.id ? 'is-self' : undefined} title={r.label}>
                  <Link to={refPath(r.kind, r.id)}>
                    <span className="mono">{r.kind === 'version' ? `v${r.id}` : r.id}</span>
                    {refLabel(r) && <span className="hc-muted"> {refLabel(r)}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <span className="none">None</span>
          )}
        </div>
      ))}
    </nav>
  );
}
