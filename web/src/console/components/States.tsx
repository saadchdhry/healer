import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../lib/api.ts';
import type { Loaded } from '../../lib/hooks.ts';

export function Loading({ what = 'data' }: { what?: string }) {
  return <p className="hc-muted">Loading {what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="hc-muted">{children}</p>;
}

export function Failed({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg =
    error instanceof ApiError
      ? error.status === 0
        ? 'The healer service is not answering. Start it, then retry.'
        : error.status === 404
          ? 'Nothing exists with this id.'
          : error.message
      : 'The request failed.';
  return (
    <div className="hc-row">
      <p className="hc-error" style={{ margin: 0 }}>
        {msg}
      </p>
      {retry && (
        <button type="button" className="hc-btn" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="hc-error">{error instanceof ApiError ? error.message : 'The request failed.'}</p>;
}

export function Q<T>({ q, what, children }: { q: Loaded<T>; what?: string; children: (data: T) => ReactNode }) {
  if (q.data !== undefined) return <>{children(q.data)}</>;
  if (q.error) return <Failed error={q.error} retry={q.reload} />;
  return <Loading what={what} />;
}

export function NotFound() {
  return (
    <div className="hc-page-head">
      <h1>No page here</h1>
      <p className="hc-sub">
        This address does not match any part of the console. <Link to="/console">Back to the map</Link>.
      </p>
    </div>
  );
}
