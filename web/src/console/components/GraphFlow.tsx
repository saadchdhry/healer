import { Fragment } from 'react';
import type { GraphShape, ToolConfig, Trace } from '@healer/agent';
import { traceRoute } from '@healer/agent/graph';
import { tierName } from '../../lib/format.ts';
import { useApi } from '../../lib/hooks.ts';
import { Q } from './States.tsx';

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

function rows<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Splits a comma list into lines of at most `chars` characters, so step numbers stay inside their space.
function wrap<T>(items: T[], text: (item: T) => string, chars: number): T[][] {
  const out: T[][] = [];
  let width = chars;
  for (const item of items) {
    const w = text(item).length + 2;
    if (width + w > chars) {
      out.push([]);
      width = 0;
    }
    out.at(-1)!.push(item);
    width += w;
  }
  return out;
}

export function GraphFlow({ graph, trace, tools }: { graph: GraphShape; trace?: Trace; tools?: ToolConfig[] }) {
  const orderIds: string[] = [];
  const queue = [graph.entry];
  while (queue.length) {
    const id = queue.shift()!;
    if (orderIds.includes(id)) continue;
    orderIds.push(id);
    for (const e of graph.edges) if (e.from === id) queue.push(e.to);
  }
  for (const n of graph.nodes) if (!orderIds.includes(n.id)) orderIds.push(n.id);
  const nodes = orderIds.map((id) => graph.nodes.find((n) => n.id === id) ?? { id, label: id, description: '' });
  const route = trace ? traceRoute(trace, graph) : null;
  const stepsOn = (e: { from: string; to: string }) => (route ?? []).filter((s) => s.kind === 'edge' && s.from === e.from && s.to === e.to).map((s) => s.n);
  const BW = 150;
  const GAP = route ? 72 : 44;
  const W = nodes.length * BW + (nodes.length - 1) * GAP + 16;
  const Y = 14;
  const BH = 64;
  const x = (id: string) => 8 + orderIds.indexOf(id) * (BW + GAP);
  const straight = graph.edges.filter((e) => orderIds.indexOf(e.to) === orderIds.indexOf(e.from) + 1);
  const span = (e: { from: string; to: string }) => Math.abs(orderIds.indexOf(e.to) - orderIds.indexOf(e.from));
  const arcs = graph.edges.filter((e) => orderIds.indexOf(e.to) !== orderIds.indexOf(e.from) + 1);
  // With a route, the shortest arc goes nearest the nodes so its numbers sit clear of the longer arcs' lines.
  if (trace) arcs.sort((a, b) => span(a) - span(b));
  const marker = `url(#gf-${graph.id})`;
  const routeMarker = `url(#gf-${graph.id}-route)`;

  const edgeLines = (e: { from: string; to: string }) => wrap(stepsOn(e), String, 8);
  const numberLines = Math.max(1, ...straight.map((e) => edgeLines(e).length));
  const arcBase = route ? Math.max(Y + BH + 20, Y + BH / 2 + 14 + (numberLines - 1) * 12 + 26) : Y + BH + 16;
  const arcStep = route ? 46 : 18;
  const depth = (i: number) => arcBase + i * arcStep;
  const laps = (e: { from: string; to: string }) =>
    orderIds.indexOf(e.to) < orderIds.indexOf(e.from) ? stepsOn({ from: e.to, to: e.from }).length : 0;
  const mostLaps = Math.max(0, ...arcs.map(laps));

  const toolSteps = (route ?? []).filter((s) => s.kind === 'tool');
  const toolList = route ? (tools ?? []) : [];
  const COLS = 3;
  const TW = 176;
  const TG = 8;
  const groupW = COLS * TW + (COLS - 1) * TG + 20;
  const toolLines = (name: string) => wrap(toolSteps.filter((s) => s.name === name), (s) => `${s.n}${s.blocked ? ' blocked' : ''}`, 18);
  const toolRows = rows(toolList, COLS);
  const rowH = toolRows.map((line) => 25 + Math.max(1, ...line.map((t) => toolLines(t.name).length)) * 13);
  const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((n, h) => n + h + TG, 0));
  const groupTop = depth(arcs.length - 1) + 40;
  const groupH = 30 + rowH.reduce((n, h) => n + h, 0) + (toolRows.length - 1) * TG + 10;
  const groupX = Math.min(Math.max(x('run_tools') + BW / 2 - groupW / 2, 8), W - 8 - groupW);
  const H = !route ? Y + BH + (arcs.length ? 26 + arcs.length * 18 : 12) : toolList.length ? groupTop + groupH + 8 : depth(arcs.length - 1) + 40;
  const visited = new Set((route ?? []).flatMap((s) => (s.kind === 'edge' ? [s.from, s.to] : [])));

  return (
    <div className="hc-panel" style={{ overflowX: 'auto' }}>
      <svg className="hc-map" viewBox={`0 0 ${W} ${H}`} style={{ minWidth: Math.min(W, 900) }} role="img" aria-label={`Graph ${graph.id}`}>
        <defs>
          <marker id={`gf-${graph.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path className="arrowhead" d="M1,1 L9,5 L1,9 Z" />
          </marker>
          {route && (
            <marker id={`gf-${graph.id}-route`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path className="arrowhead taken" d="M1,1 L9,5 L1,9 Z" />
            </marker>
          )}
        </defs>
        {straight.map((e, i) => {
          const steps = stepsOn(e);
          return (
            <g key={`f${i}`}>
              <path
                className={steps.length ? 'edge taken' : 'edge'}
                d={`M${x(e.from) + BW + 2},${Y + BH / 2} H${x(e.to) - 6}`}
                markerEnd={steps.length ? routeMarker : marker}
              />
              {e.label && (
                <text className="t-edge" x={x(e.from) + BW + GAP / 2} y={Y + BH / 2 - 8} textAnchor="middle">
                  {e.label}
                </text>
              )}
              {edgeLines(e).map((line, j) => (
                <text key={j} className="t-step" x={x(e.from) + BW + GAP / 2} y={Y + BH / 2 + 14 + j * 12} textAnchor="middle">
                  {line.join(', ')}
                </text>
              ))}
            </g>
          );
        })}
        {arcs.map((e, i) => {
          const a = x(e.from) + BW / 2 + 10;
          const b = x(e.to) + BW / 2 - 10;
          const steps = stepsOn(e);
          const lap = laps(e);
          return (
            <g key={`a${i}`}>
              <path
                className={steps.length ? 'edge taken' : 'edge'}
                d={`M${a},${Y + BH + 2} V${depth(i)} H${b} V${Y + BH + 6}`}
                markerEnd={steps.length ? routeMarker : marker}
              />
              <text className="t-edge" x={(a + b) / 2} y={depth(i) - 4} textAnchor="middle">
                {e.label ?? ''}
              </text>
              {steps.length > 0 && (
                <text className="t-step" x={(a + b) / 2} y={depth(i) + 13} textAnchor="middle">
                  {steps.join(', ')}
                </text>
              )}
              {lap > 0 && (
                <text className="t-edge" x={(a + b) / 2} y={depth(i) + 26} textAnchor="middle">
                  Went round the loop {times(lap)}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => (
          <g key={n.id}>
            <title>{n.description}</title>
            <rect x={x(n.id)} y={Y} width={BW} height={BH} rx={7} fill="var(--panel-2)" stroke={visited.has(n.id) ? 'var(--focus)' : 'var(--rule)'} />
            <text className="t-title" style={{ fontSize: 13.5 }} x={x(n.id) + 10} y={Y + 22}>
              {n.label}
            </text>
            <text className="t-desc" style={{ fontFamily: 'var(--mono)', fontSize: 11 }} x={x(n.id) + 10} y={Y + 42}>
              {n.id}
            </text>
          </g>
        ))}
        {trace && orderIds.includes('route') && (
          <g>
            <text className="t-step" x={x('route') + 10} y={Y + BH + 18}>
              Chose {tierName[trace.tierUsed]}
            </text>
            {trace.routerDecision && (
              <text className="t-edge" x={x('route') + 10} y={Y + BH + 32}>
                Router score {trace.routerDecision.score.toFixed(2)}
              </text>
            )}
          </g>
        )}
        {toolList.length > 0 && (
          <g>
            <rect className="group" x={groupX} y={groupTop} width={groupW} height={groupH} rx={8} />
            <text className="t-group" x={groupX + 10} y={groupTop + 19}>
              Tools in version {trace!.versionId}, run by <tspan style={{ fontFamily: 'var(--mono)' }}>run_tools</tspan>
            </text>
            {toolRows.flatMap((line, r) =>
              line.map((t, c) => {
                const tx = groupX + 10 + c * (TW + TG);
                const ty = groupTop + 30 + rowY[r]!;
                const lines = toolLines(t.name);
                return (
                  <g key={t.name} opacity={t.enabled ? 1 : 0.45}>
                    <rect x={tx} y={ty} width={TW} height={rowH[r]} rx={5} fill="var(--panel)" stroke={lines.length ? 'var(--focus)' : 'var(--rule)'} />
                    <text style={{ fontFamily: 'var(--mono)', fontSize: 11, fill: 'var(--ink)' }} x={tx + 8} y={ty + 15}>
                      {t.name}
                    </text>
                    {!t.enabled && (
                      <text className="t-edge" style={{ fontSize: 11 }} x={tx + 8} y={ty + 30}>
                        disabled
                      </text>
                    )}
                    {lines.map((line, j) => (
                      <text key={j} className="t-step" x={tx + 8} y={ty + 30 + j * 13}>
                        {j === 0 && (lines.flat().length === 1 ? 'Step ' : 'Steps ')}
                        {line.map((s, k) => (
                          <Fragment key={s.n}>
                            {k > 0 && ', '}
                            {s.n}
                            {s.blocked && <tspan className="t-blocked"> blocked</tspan>}
                          </Fragment>
                        ))}
                      </text>
                    ))}
                  </g>
                );
              }),
            )}
          </g>
        )}
      </svg>
      {route && (
        <p className="hc-muted" style={{ margin: '8px 0 0', fontSize: 12.5 }}>
          Highlighted edges are the route this trace took, numbered in order together with its tool calls. Grey edges are branches it did not take.
          {mostLaps > 3 &&
            ` This trace went round the loop ${mostLaps} times, which makes the numbers on the loop hard to read. The trace's Timeline is the place to read a long trace step by step.`}
        </p>
      )}
      <ul className="hc-muted" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
        {nodes.map((n) => (
          <li key={n.id}>
            <span className="mono">{n.id}</span>: {n.description}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TraceRoute({ trace }: { trace: Trace }) {
  const graphs = useApi('GET /api/healer/graphs', []);
  const version = useApi('GET /api/healer/versions/:id', [{ params: { id: trace.versionId } }]);
  return (
    <Q q={graphs} what="the agent graph">
      {(g) => <Q q={version} what={`version ${trace.versionId}`}>{(v) => <GraphFlow graph={g.agent} trace={trace} tools={v.version.harness.tools} />}</Q>}
    </Q>
  );
}
