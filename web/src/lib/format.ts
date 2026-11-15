import type { ModelConfig, Scope, Tier, TraceSource } from '@healer/agent';

export const tierName: Record<Tier, string> = { haiku: 'Haiku 5.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5' };

export const sourceWord: Record<TraceSource, string> = {
  shop: 'Shop front',
  simulator: 'Simulated customers',
  seed: 'Seeded cases',
  eval: 'Eval runs (sandbox)',
  redteam: 'Red team probes (sandbox)',
  replay: 'Router replays (sandbox)',
};

export function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function money(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return 'none yet';
  return `${(n * 100).toFixed(digits)}%`;
}

export function int(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n);
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function date(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ms(startIso: string, endIso: string | null): string {
  if (!endIso) return 'running';
  const d = new Date(endIso).getTime() - new Date(startIso).getTime();
  return d < 1000 ? `${d} ms` : `${(d / 1000).toFixed(2)} s`;
}

export function ago(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return dateTime(iso);
}

export function scopeLabel(scope: Scope, customerName?: (id: string) => string): string {
  return scope.kind === 'shop' ? 'Shop-wide' : `Customer ${customerName ? customerName(scope.customerId) : scope.customerId}`;
}

export function modelLabel(m: ModelConfig): string {
  if (m.mode === 'fixed') return `${tierName[m.tier]}, effort ${m.effort}`;
  return `Routed: ${tierName[m.easyTier]} or ${tierName[m.hardTier]}, router ${m.router.id}`;
}
