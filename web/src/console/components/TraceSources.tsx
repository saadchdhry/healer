import type { KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TraceSource } from '@healer/agent';
import { useApi } from '../../lib/hooks.ts';
import { sourceWord } from '../../lib/format.ts';

// Rows are fixed so the arrows can be drawn as straight segments. A new TraceSource fails the typecheck here until it has a row.
const SOURCES: Record<TraceSource, { y: number; startedBy: string; grade?: string[] }> = {
  shop: { y: 48, startedBy: 'Started by a person in the shop front' },
  simulator: { y: 122, startedBy: 'Started from the Traffic panel' },
  seed: { y: 196, startedBy: 'Fired from the Traffic panel' },
  eval: { y: 322, startedBy: 'Started by the gate or the Eval suite page', grade: ["The eval case's checks"] },
  redteam: { y: 396, startedBy: 'Started by the red team probe on the map page', grade: ['Compared with a paraphrase'] },
  replay: { y: 470, startedBy: 'Started by Build dataset on the Model page', grade: ['Compared with the stronger', 'tier, in code'] },
};

const SRC_X = 24;
const SRC_W = 320;
const BOX_H = 64;
const SHOP = { x: 404, y: 122, w: 100, h: 64 };
const HEALER = { x: 574, y: 48, w: 100, h: 486 };
const GRADE_X = 734;
const GRADE_W = 242;
const LIVE_MID = SHOP.y + SHOP.h / 2;
const JUDGE = ['Judge: policy rules and', 'the judge model'];

export function TraceSources({ selected }: { selected: TraceSource | '' }) {
  const navigate = useNavigate();
  const counts = useApi('GET /api/healer/traces/sources', [], ['trace']).data;
  const right = SRC_X + SRC_W;

  const sourceBox = (s: TraceSource) => {
    const { y, startedBy } = SOURCES[s];
    const go = () => navigate(`/console/traces?source=${s}`);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    };
    return (
      <g
        key={s}
        className={`blk found${selected === s ? ' is-on' : ''}`}
        role="link"
        tabIndex={0}
        aria-label={`${sourceWord[s]}: ${counts ? counts[s] : 'loading'} traces. Show them in the Explorer.`}
        onClick={go}
        onKeyDown={onKey}
      >
        <rect className="face" x={SRC_X} y={y} width={SRC_W} height={BOX_H} rx={8} />
        <text className="t-title" x={SRC_X + 14} y={y + 26}>
          {sourceWord[s]}
        </text>
        <text className="t-count small" x={right - 14} y={y + 28}>
          {counts ? counts[s] : '…'}
        </text>
        <text className="t-desc" x={SRC_X + 14} y={y + 48}>
          {startedBy}
        </text>
      </g>
    );
  };

  const gradeBox = (key: string, mid: number, lines: string[]) => (
    <g key={key}>
      <rect className="box" x={GRADE_X} y={mid - BOX_H / 2} width={GRADE_W} height={BOX_H} rx={8} />
      {lines.map((line, i) => (
        <text key={i} className="t-cap" x={GRADE_X + 14} y={mid + 4 + (i - (lines.length - 1) / 2) * 18}>
          {line}
        </text>
      ))}
    </g>
  );

  const arrow = (d: string, key: string, dashed = false) => <path key={key} className={`edge${dashed ? ' link' : ''}`} d={d} markerEnd="url(#hc-src-arrow)" />;
  const all = Object.keys(SOURCES) as TraceSource[];
  const live = all.filter((s) => !SOURCES[s].grade);
  const sandbox = all.filter((s) => SOURCES[s].grade);

  return (
    <svg className="hc-map" viewBox="0 0 1000 556" role="group" aria-label="Where traces come from, and what grades each">
      <defs>
        <marker id="hc-src-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path className="arrowhead" d="M1,1 L9,5 L1,9 Z" />
        </marker>
      </defs>
      <text className="t-group" x={24} y={26}>
        Through the live shop
      </text>
      <rect className="group" x={12} y={36} width={344} height={234} rx={10} />
      <text className="t-group" x={24} y={300}>
        In a sandbox, on a copy of the records
      </text>
      <rect className="group" x={12} y={310} width={344} height={234} rx={10} />
      <text className="t-group" x={GRADE_X} y={26}>
        What grades it
      </text>

      {live.map((s) => {
        const mid = SOURCES[s].y + BOX_H / 2;
        const end = SHOP.x - 6;
        const into = Math.max(SHOP.y + 12, Math.min(SHOP.y + SHOP.h - 12, mid));
        return arrow(mid === into ? `M${right},${mid} H${end}` : `M${right},${mid} H${right + 30} V${into} H${end}`, s);
      })}
      <rect className="box" x={SHOP.x} y={SHOP.y} width={SHOP.w} height={SHOP.h} rx={8} />
      <text className="t-title" x={SHOP.x + SHOP.w / 2} y={SHOP.y + 28} textAnchor="middle">
        Shop
      </text>
      <text className="t-desc" x={SHOP.x + SHOP.w / 2} y={SHOP.y + 48} textAnchor="middle">
        live records
      </text>
      {arrow(`M${SHOP.x + SHOP.w},${LIVE_MID} H${HEALER.x - 6}`, 'trace', true)}
      <text className="t-edge" x={(SHOP.x + SHOP.w + HEALER.x) / 2} y={LIVE_MID - 8} textAnchor="middle">
        trace
      </text>

      {sandbox.map((s) => {
        const mid = SOURCES[s].y + BOX_H / 2;
        return arrow(`M${right},${mid} H${HEALER.x - 6}`, s);
      })}

      <rect className="box" x={HEALER.x} y={HEALER.y} width={HEALER.w} height={HEALER.h} rx={8} />
      <text className="t-title" x={HEALER.x + HEALER.w / 2} y={HEALER.y + HEALER.h / 2 - 6} textAnchor="middle">
        Healer
      </text>
      <text className="t-desc" x={HEALER.x + HEALER.w / 2} y={HEALER.y + HEALER.h / 2 + 14} textAnchor="middle">
        keeps every
      </text>
      <text className="t-desc" x={HEALER.x + HEALER.w / 2} y={HEALER.y + HEALER.h / 2 + 30} textAnchor="middle">
        trace
      </text>

      {arrow(`M${HEALER.x + HEALER.w},${LIVE_MID} H${GRADE_X - 6}`, 'judge')}
      {gradeBox('judge', LIVE_MID, JUDGE)}
      {sandbox.map((s) => {
        const mid = SOURCES[s].y + BOX_H / 2;
        return [arrow(`M${HEALER.x + HEALER.w},${mid} H${GRADE_X - 6}`, `${s}-grade`), gradeBox(s, mid, SOURCES[s].grade!)];
      })}

      {live.map(sourceBox)}
      {sandbox.map(sourceBox)}
    </svg>
  );
}
