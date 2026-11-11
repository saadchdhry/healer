import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GraphShape, LoopStage, Overview } from '@healer/agent';
import { pct, tierName } from '../lib/format.ts';

type BlockId = 'run' | 'judge' | 'diagnose' | 'propose' | 'gate' | 'context' | 'harness' | 'model' | 'traces' | 'evals';
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const BW = 210;
const BH = 104;
const pos: Record<BlockId, Box> = {
  run: { x: 24, y: 44, w: BW, h: BH },
  judge: { x: 274, y: 44, w: BW, h: BH },
  diagnose: { x: 524, y: 44, w: BW, h: BH },
  propose: { x: 774, y: 44, w: BW, h: BH },
  gate: { x: 774, y: 236, w: BW, h: BH },
  context: { x: 28, y: 236, w: 214, h: BH },
  harness: { x: 262, y: 236, w: 214, h: BH },
  model: { x: 496, y: 236, w: 214, h: BH },
  traces: { x: 24, y: 436, w: 465, h: 100 },
  evals: { x: 519, y: 436, w: 465, h: 100 },
};
const surfacesGroup: Box = { x: 12, y: 200, w: 714, h: 156 };
const foundationsGroup: Box = { x: 12, y: 400, w: 984, h: 148 };

const route: Record<BlockId, string> = {
  run: '/console/run',
  judge: '/console/judge',
  diagnose: '/console/diagnose',
  propose: '/console/propose',
  gate: '/console/gate',
  context: '/console/context',
  harness: '/console/harness',
  model: '/console/model',
  traces: '/console/traces',
  evals: '/console/evals',
};

const fallbackLoop: GraphShape = {
  id: 'loop',
  entry: 'run',
  nodes: [],
  edges: [
    { from: 'judge', to: 'diagnose' },
    { from: 'diagnose', to: 'propose' },
    { from: 'propose', to: 'gate' },
    { from: 'gate', to: 'promote' },
  ],
};

// The only pairs the layout can join with a straight segment that crosses no block. Other paths are listed under the map.
const DRAWN = new Set(['judge>diagnose', 'diagnose>propose', 'propose>gate', 'gate>propose', 'gate>promote']);

// Not part of the healer's graph: these two cross between the shop and the healer, and are the whole contract between them.
const LINKS = [
  { from: 'run', to: 'judge', label: 'trace' },
  { from: 'promote', to: 'run', label: 'new version' },
];
const SHORT_LABEL = 8;
const LONG_LABEL = 24;
const fixedDesc: Partial<Record<BlockId, string>> = {
  run: 'The agent acts',
  judge: 'Was it good?',
  diagnose: 'Why, and which part is at fault',
  propose: 'Draft a change for one surface',
  gate: 'Do all evals still pass?',
  context: 'Memory and notes. Cheap, instant',
  harness: 'Prompt, tools, guards. Affects everyone',
  model: 'Tier and router weights. Slow, costly',
  traces: 'Exact inputs, outputs and every step. The evidence',
  evals: 'What good looks like. Grows with every failure',
};

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

interface EdgeGeom {
  d: string;
  lx: number;
  ly: number;
  vertical: boolean;
}

function edgeGeom(from: string, to: string): EdgeGeom | null {
  const R = (id: string): Box | null => (id === 'promote' ? surfacesGroup : (pos as Record<string, Box>)[id] ?? null);
  const a = R(from);
  const b = R(to);
  if (!a || !b) return null;
  if (from === 'promote' && to === 'run') {
    const x = b.x + b.w / 2;
    return { d: `M${x},${a.y - 2} V${b.y + b.h + 6}`, lx: x + 8, ly: (a.y + b.y + b.h) / 2 + 4, vertical: true };
  }
  if (to === 'promote') {
    const y = a.y + a.h / 2;
    return { d: `M${a.x - 2},${y} H${b.x + b.w + 6}`, lx: (a.x + b.x + b.w) / 2, ly: y - 8, vertical: false };
  }
  if (Math.abs(a.y - b.y) < 1) {
    const y = a.y + a.h / 2;
    const [l, r] = a.x < b.x ? [a.x + a.w, b.x] : [a.x, b.x + b.w];
    return { d: `M${l + 2},${y} H${a.x < b.x ? r - 6 : r + 6}`, lx: (l + r) / 2, ly: y - 8, vertical: false };
  }
  if (Math.abs(a.x - b.x) < 1) {
    // Down and up between the same two blocks sit side by side, so a retry reads as its own arrow.
    const down = a.y < b.y;
    const x = a.x + a.w / 2 + (down ? -10 : 10);
    const [t, u] = down ? [a.y + a.h, b.y] : [a.y, b.y + b.h];
    return { d: `M${x},${down ? t + 2 : t - 2} V${down ? u - 6 : u + 6}`, lx: x + 8, ly: (t + u) / 2 + 4, vertical: true };
  }
  return null;
}

export function ConceptMap({ overview, active, loop }: { overview: Overview | null; active: Set<LoopStage>; loop: GraphShape | null }) {
  const navigate = useNavigate();
  const graph = loop ?? fallbackLoop;
  const desc = (id: BlockId) => graph.nodes.find((n) => n.id === id)?.description ?? fixedDesc[id] ?? '';
  const label = (id: BlockId, fallback: string) => graph.nodes.find((n) => n.id === id)?.label ?? fallback;
  const c = overview?.counts;
  const promoteHot = active.has('promote');

  const block = (id: BlockId, title: string, count: ReactNode, caption: string, opts: { kind?: 'stage' | 'surface' | 'found'; color?: string; extra?: ReactNode; activeKey?: LoopStage } = {}) => {
    const b = pos[id];
    const isActive = opts.activeKey ? active.has(opts.activeKey) : false;
    const go = () => navigate(route[id]);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    };
    const d = desc(id);
    return (
      <g
        className={`blk ${opts.kind ?? 'stage'}${isActive ? ' is-active' : ''}`}
        style={opts.color ? ({ '--c': opts.color } as CSSProperties) : undefined}
        role="link"
        tabIndex={0}
        aria-label={`${title}: ${caption}. Open the deep dive.`}
        onClick={go}
        onKeyDown={onKey}
      >
        <title>{d}</title>
        <rect className="halo" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
        <rect className="face" x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
        {opts.kind === 'surface' && <rect className="band" x={b.x} y={b.y + 10} width={3} height={b.h - 20} rx={1.5} />}
        <text className="t-title" x={b.x + 16} y={b.y + 28}>
          {title}
        </text>
        <circle className="live-dot" cx={b.x + 28 + title.length * 9.4} cy={b.y + 23} r={3.5} />
        <text className={`t-count${typeof count === 'string' && count.length > 6 ? ' small' : ''}`} x={b.x + b.w - 16} y={b.y + 34}>
          {count}
        </text>
        <text className="t-cap" x={b.x + 16} y={b.y + 58}>
          {caption}
        </text>
        <text className="t-desc" x={b.x + 16} y={b.y + 80}>
          {clip(d, Math.floor(b.w / 5.9))}
        </text>
        {opts.extra}
      </g>
    );
  };

  const judgeBar = (() => {
    if (!c) return null;
    const total = c.verdictsPassed + c.verdictsFailed;
    if (!total) return null;
    const b = pos.judge;
    const w = b.w - 32;
    const pw = (c.verdictsPassed / total) * w;
    return (
      <g>
        <rect className="mini-pass" x={b.x + 16} y={b.y + 90} width={Math.max(pw - 1, 0)} height={4} rx={2} />
        <rect className="mini-fail" x={b.x + 16 + pw + 1} y={b.y + 90} width={Math.max(w - pw - 1, 0)} height={4} rx={2} />
      </g>
    );
  })();

  const liveTier = overview ? (overview.liveModel.mode === 'fixed' ? tierName[overview.liveModel.tier] : 'Routed') : '…';
  const n = (v: number | undefined) => (v === undefined ? '…' : String(v));
  const isDrawn = (e: GraphShape['edges'][number]) => DRAWN.has(`${e.from}>${e.to}`);
  // A gap between blocks fits a word across and a short phrase down; longer labels go to the list under the map.
  const labelOnMap = (e: GraphShape['edges'][number], g: EdgeGeom) => (e.label && e.label.length <= (g.vertical ? LONG_LABEL : SHORT_LABEL) ? e.label : undefined);
  const stageName = (id: string) => (id === '__end__' ? 'stop' : (graph.nodes.find((nd) => nd.id === id)?.label ?? id));
  const listed = graph.edges.filter((e) => e.label && (!isDrawn(e) || !labelOnMap(e, edgeGeom(e.from, e.to)!)));
  const extraNodes = graph.nodes.filter((nd) => !(nd.id in pos) && nd.id !== 'promote');

  return (
    <div>
      <svg className="hc-map" viewBox="0 0 1000 560" role="group" aria-label="The learning loop, live">
        <defs>
          <marker id="hc-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path className="arrowhead" d="M1,1 L9,5 L1,9 Z" />
          </marker>
        </defs>
        <text className="t-group" x={24} y={26}>
          The loop
        </text>
        <rect className="group" x={surfacesGroup.x} y={surfacesGroup.y} width={surfacesGroup.w} height={surfacesGroup.h} rx={10} />
        <text className="t-group" x={28} y={222}>
          What can change
        </text>
        <rect className="group" x={foundationsGroup.x} y={foundationsGroup.y} width={foundationsGroup.w} height={foundationsGroup.h} rx={10} />
        <text className="t-group" x={24} y={422}>
          Foundations under every stage
        </text>

        {LINKS.map((l) => {
          const g = edgeGeom(l.from, l.to)!;
          const hot = l.from === 'promote' ? promoteHot : active.has('run');
          return (
            <g key={l.from}>
              <path className={`edge link${hot ? ' hot' : ''}`} d={g.d} markerEnd="url(#hc-arrow)" />
              <text className="t-edge" x={g.lx} y={g.ly} textAnchor={g.vertical ? 'start' : 'middle'}>
                {l.label}
              </text>
            </g>
          );
        })}
        {graph.edges.filter(isDrawn).map((e, i) => {
          const g = edgeGeom(e.from, e.to)!;
          const text = labelOnMap(e, g);
          return (
            <g key={i}>
              <path className={`edge${active.has(e.from as LoopStage) ? ' hot' : ''}`} d={g.d} markerEnd="url(#hc-arrow)" />
              {text && (
                <text className="t-edge" x={g.lx} y={g.ly} textAnchor={g.vertical ? 'start' : 'middle'}>
                  {text}
                </text>
              )}
            </g>
          );
        })}
        <path className="edge feed" d={`M${pos.gate.x + pos.gate.w / 2},${pos.evals.y - 2} V${pos.gate.y + pos.gate.h + 4}`} />
        <text className="t-edge" x={pos.gate.x + pos.gate.w / 2 + 8} y={(pos.evals.y + pos.gate.y + pos.gate.h) / 2 + 4}>
          runs the whole suite
        </text>

        {block('run', label('run', 'Run'), n(c?.traces), 'conversations handled', { activeKey: 'run' })}
        {block('judge', label('judge', 'Judge'), n(c ? c.verdictsPassed + c.verdictsFailed : undefined), c ? `${c.verdictsPassed} passed, ${c.verdictsFailed} failed` : 'verdicts', { activeKey: 'judge', extra: judgeBar })}
        {block('diagnose', label('diagnose', 'Diagnose'), n(c?.issuesOpen), c ? `open, of ${c.issuesTotal} issues` : 'open issues', { activeKey: 'diagnose' })}
        {block('propose', label('propose', 'Propose'), n(c?.proposalsAwaitingApproval), c ? `awaiting approval, of ${c.proposalsTotal}` : 'awaiting approval', { activeKey: 'propose' })}
        {block('gate', label('gate', 'Gate'), n(c ? c.gateRunsAccepted + c.gateRunsRejected : undefined), c ? `${c.gateRunsAccepted} accepted, ${c.gateRunsRejected} rejected` : 'gate runs', { activeKey: 'gate' })}
        {block('context', 'Context', n(c?.contextNotes), 'notes in the live version', { kind: 'surface', color: 'var(--context)', activeKey: 'promote' })}
        {block('harness', 'Harness', overview ? `v${overview.liveVersionId}` : '…', c ? `live, ${c.versions} versions in all` : 'live version', { kind: 'surface', color: 'var(--harness)', activeKey: 'promote' })}
        {block('model', 'Model', liveTier, c ? `${c.routerExamples} router examples` : 'live tier', { kind: 'surface', color: 'var(--model)', activeKey: 'promote' })}
        {block('traces', 'Traces', n(c?.traces), 'traces recorded, each a full record of one reply', { kind: 'found' })}
        {block('evals', 'Eval suite', n(c?.evalCases), overview ? `cases. Live version passes ${pct(overview.latestPassRate)}` : 'cases', { kind: 'found' })}
      </svg>
      {listed.length > 0 && (
        <p className="hc-muted" style={{ margin: '6px 0 0' }}>
          Other paths in the loop's code:{' '}
          {listed.map((e) => `${stageName(e.from)} → ${stageName(e.to)} (${e.label})`).join('; ')}. Dashed arrows cross between the shop and the healer.
        </p>
      )}
      {extraNodes.length > 0 && (
        <p className="hc-muted" style={{ margin: '6px 0 0' }}>
          Also in the loop graph but not drawn on the map: {extraNodes.map((x) => `${x.label} (${x.description})`).join('; ')}.
        </p>
      )}
    </div>
  );
}
