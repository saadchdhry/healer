import { Link } from 'react-router-dom';
import type { Customer, Rating, TraceSummary } from '@healer/agent';
import { useApi } from '../../lib/hooks.ts';
import { tierName, time, usd } from '../../lib/format.ts';
import { IdLink, VerdictBadge } from './ui.tsx';

export function useCustomers() {
  const q = useApi('GET /api/healer/customers', []);
  const list: Customer[] = q.data ?? [];
  return { list, name: (id: string) => list.find((c) => c.id === id)?.name ?? id };
}

export function RatingMark({ rating }: { rating: Rating | null }) {
  if (!rating) return <span className="hc-muted">none</span>;
  return <span className={`hc-verdict ${rating === 'up' ? 'pass' : 'fail'}`}>{rating === 'up' ? 'Thumbs up' : 'Thumbs down'}</span>;
}

export function TraceTable({ traces, showOutput = false, highlight }: { traces: TraceSummary[]; showOutput?: boolean; highlight?: Set<string> }) {
  const { name } = useCustomers();
  return (
    <div className="hc-scroll">
    <table className={`hc-table${showOutput ? ' hc-narrow-clip' : ''}`}>
      <thead>
        <tr>
          <th>Time</th>
          <th>Trace</th>
          <th className="mid-only">Customer</th>
          <th className="mid-only">Source</th>
          <th className="wide-only">Version</th>
          <th>Message</th>
          {showOutput && <th>Reply</th>}
          <th>Verdict</th>
          <th className="wide-only">Rating</th>
          <th className="wide-only">Tier</th>
          <th className="num wide-only">Cost</th>
        </tr>
      </thead>
      <tbody>
        {traces.map((t) => (
          <tr key={t.id} className={highlight?.has(t.id) ? 'is-hl' : undefined}>
            <td className="mono hc-muted">{time(t.startedAt)}</td>
            <td className="id-cell" title={t.id}>
              <IdLink kind="trace" id={t.id} />
            </td>
            <td className="mid-only">
              <Link to={`/console/traces?customer=${t.customerId}`}>{name(t.customerId)}</Link>
            </td>
            <td className="mid-only">{t.source}</td>
            <td className="wide-only">
              <IdLink kind="version" id={t.versionId} />
            </td>
            <td className="clip" title={t.input}>
              {t.input}
            </td>
            {showOutput && (
              <td className="clip" title={t.output}>
                {t.output}
              </td>
            )}
            <td>
              <VerdictBadge state={t.verdict} />
            </td>
            <td className="wide-only">
              <RatingMark rating={t.rating} />
            </td>
            <td className="wide-only">{tierName[t.tierUsed]}</td>
            <td className="num mono wide-only">{usd(t.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
