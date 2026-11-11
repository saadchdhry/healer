import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentVersion, CostByRole, EvalRun } from '@healer/agent';
import { pct, usd } from '../../lib/format.ts';

type Tip = { x: number; y: number; text: string } | null;

function TipBox({ tip, w, h }: { tip: Tip; w: number; h: number }) {
  if (!tip) return null;
  return (
    <div className="hc-tip" style={{ left: `${(tip.x / w) * 100}%`, top: `${(tip.y / h) * 100}%` }}>
      {tip.text}
    </div>
  );
}

const statusWord: Record<AgentVersion['status'], string> = { live: 'Live', superseded: 'Superseded', candidate: 'Candidate', rejected: 'Rejected' };

export function PassRateChart({ versions, runs }: { versions: AgentVersion[]; runs: EvalRun[] }) {
  const navigate = useNavigate();
  const [tip, setTip] = useState<Tip>(null);
  const points = versions
    .map((v) => ({ v, run: runs.filter((r) => r.versionId === v.id && r.status === 'done').sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) }))
    .filter((p): p is { v: AgentVersion; run: EvalRun } => p.run !== undefined);
  if (!points.length) return <p className="hc-muted">No eval runs have finished yet. Run the suite on a version from the eval suite page and its pass rate appears here.</p>;
  const W = 380;
  const H = 210;
  const L = 36;
  const B = 24;
  const T = 18;
  const plotH = H - B - T;
  const band = (W - L - 8) / points.length;
  const colW = Math.min(24, band * 0.6);
  const y = (r: number) => T + plotH * (1 - r);
  const statuses = [...new Set(points.map((p) => p.v.status))];

  return (
    <div className="hc-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Pass rate of the eval suite for each version">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - 4} y1={y(t)} y2={y(t)} />
            <text className="axis" x={L - 6} y={y(t) + 4} textAnchor="end">
              {t * 100}%
            </text>
          </g>
        ))}
        {points.map(({ v, run }, i) => {
          const cx = L + band * i + band / 2;
          const top = y(run.passRate);
          const hgt = Math.max(H - B - top, 1);
          const r = Math.min(4, hgt);
          const x0 = cx - colW / 2;
          const d = `M${x0},${H - B} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + colW - r} Q${x0 + colW},${top} ${x0 + colW},${top + r} V${H - B} Z`;
          const text = `v${v.id}, ${statusWord[v.status].toLowerCase()}: ${pct(run.passRate)} pass rate, ${usd(run.costPerTaskUsd)} per task`;
          return (
            <g key={v.id}>
              <path className={`col ${v.status}`} d={d} />
              <text className="val" x={cx} y={top - 5} textAnchor="middle">
                {pct(run.passRate)}
              </text>
              <text className="axis" x={cx} y={H - 8} textAnchor="middle">
                v{v.id}
              </text>
              <rect
                className="hit"
                x={cx - band / 2}
                y={T - 10}
                width={band}
                height={H - T}
                onMouseEnter={() => setTip({ x: cx, y: top, text })}
                onMouseLeave={() => setTip(null)}
                onClick={() => navigate(`/console/versions/${v.id}`)}
                style={{ cursor: 'pointer' }}
              >
                <title>{text}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <TipBox tip={tip} w={W} h={H} />
      <div className="hc-legend">
        {statuses.map((s) => (
          <span key={s}>
            <i style={{ background: s === 'live' ? 'var(--ink)' : s === 'rejected' ? 'var(--fail)' : s === 'candidate' ? 'var(--ink-3)' : 'var(--ink-2)' }} />
            {statusWord[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

export function LossCurve({ curve, label }: { curve: number[]; label: string }) {
  const [tip, setTip] = useState<Tip>(null);
  if (curve.length < 2) return <p className="hc-muted">Train the router to see its loss curve.</p>;
  const W = 520;
  const H = 180;
  const L = 40;
  const B = 24;
  const T = 10;
  const max = Math.max(...curve) * 1.05;
  const x = (i: number) => L + ((W - L - 8) * i) / (curve.length - 1);
  const y = (v: number) => T + (H - B - T) * (1 - v / max);
  const d = curve.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ticks = [0, max / 2, max];
  const last = curve.at(-1)!;

  return (
    <div className="hc-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          const i = Math.round(((px - L) / (W - L - 8)) * (curve.length - 1));
          if (i < 0 || i >= curve.length) return setTip(null);
          setTip({ x: x(i), y: y(curve[i]!), text: `Step ${i + 1}: loss ${curve[i]!.toFixed(3)}` });
        }}
        onMouseLeave={() => setTip(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={L} x2={W - 4} y1={y(t)} y2={y(t)} />
            <text className="axis" x={L - 6} y={y(t) + 4} textAnchor="end">
              {t.toFixed(2)}
            </text>
          </g>
        ))}
        <text className="axis" x={L} y={H - 6}>
          step 1
        </text>
        <text className="axis" x={W - 8} y={H - 6} textAnchor="end">
          step {curve.length}
        </text>
        <path className="line" d={d} />
        <circle cx={x(curve.length - 1)} cy={y(last)} r={4} fill="var(--ink)" stroke="var(--panel)" strokeWidth={2} />
        <text className="val" x={x(curve.length - 1) - 8} y={y(last) - 10} textAnchor="end">
          {last.toFixed(3)}
        </text>
        {tip && <line className="cross" x1={tip.x} x2={tip.x} y1={T} y2={H - B} />}
        {tip && <circle cx={tip.x} cy={tip.y} r={4} fill="var(--ink)" stroke="var(--panel)" strokeWidth={2} />}
      </svg>
      <TipBox tip={tip} w={W} h={H} />
    </div>
  );
}

export function CostMeter({ byRole, total }: { byRole: CostByRole[]; total: number }) {
  if (!byRole.length) return <p className="hc-muted">No model calls yet. Spend appears here once the agent or the loop calls a model.</p>;
  const max = Math.max(...byRole.map((r) => r.costUsd), 0.000001);
  return (
    <div>
      {byRole.map((r) => (
        <div className="hc-meter" key={r.role} title={`${r.calls} calls, ${r.inputTokens} input tokens, ${r.outputTokens} output tokens`}>
          <span>{r.role.charAt(0).toUpperCase() + r.role.slice(1)}</span>
          <span className="track">
            <span className="fill" style={{ width: `${(r.costUsd / max) * 100}%`, display: 'block' }} />
          </span>
          <span className="num">{usd(r.costUsd)}</span>
        </div>
      ))}
      <div className="hc-meter" style={{ borderTop: '1px solid var(--rule-2)', marginTop: 4, paddingTop: 6 }}>
        <span>Total</span>
        <span />
        <span className="num">{usd(total)}</span>
      </div>
    </div>
  );
}
