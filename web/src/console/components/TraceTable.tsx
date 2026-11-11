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
          <th>Customer</th>
          <th>Source</th>
          <th>Version</th>
          <th>Message</th>
          {showOutput && <th>Reply</th>}
          <th>Verdict</th>
          <th>Rating</th>
          <th>Tier</th>
          <th className="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {traces.map((t) => (
          <tr key={t.id} className={highlight?.has(t.id) ? 'is-hl' : undefined}>
            <td className="mono hc-muted">{time(t.startedAt)}</td>
            <td>
              <IdLink kind="trace" id={t.id} />
            </td>
            <td>
              <Link to={`/console/traces?customer=${t.customerId}`}>{name(t.customerId)}</Link>
            </td>
            <td>{t.source}</td>
            <td>
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
            <td>
              <RatingMark rating={t.rating} />
            </td>
            <td>{tierName[t.tierUsed]}</td>
            <td className="num mono">{usd(t.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
