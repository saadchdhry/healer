import type { GraphShape } from '@healer/agent';

export function GraphFlow({ graph }: { graph: GraphShape }) {
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
  const BW = 150;
  const GAP = 44;
  const W = nodes.length * BW + (nodes.length - 1) * GAP + 16;
  const Y = 14;
  const BH = 64;
  const x = (id: string) => 8 + orderIds.indexOf(id) * (BW + GAP);
  const arcs = graph.edges.filter((e) => orderIds.indexOf(e.to) !== orderIds.indexOf(e.from) + 1);
  const H = Y + BH + (arcs.length ? 26 + arcs.length * 18 : 12);

  return (
    <div className="hc-panel" style={{ overflowX: 'auto' }}>
      <svg className="hc-map" viewBox={`0 0 ${W} ${H}`} style={{ minWidth: Math.min(W, 900) }} role="img" aria-label={`Graph ${graph.id}`}>
        <defs>
          <marker id={`gf-${graph.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path className="arrowhead" d="M1,1 L9,5 L1,9 Z" />
          </marker>
        </defs>
        {graph.edges
          .filter((e) => orderIds.indexOf(e.to) === orderIds.indexOf(e.from) + 1)
          .map((e, i) => (
            <g key={`f${i}`}>
              <path className="edge" d={`M${x(e.from) + BW + 2},${Y + BH / 2} H${x(e.to) - 6}`} markerEnd={`url(#gf-${graph.id})`} />
              {e.label && (
                <text className="t-edge" x={x(e.from) + BW + GAP / 2} y={Y + BH / 2 - 8} textAnchor="middle">
                  {e.label}
                </text>
              )}
            </g>
          ))}
        {arcs.map((e, i) => {
          const a = x(e.from) + BW / 2 + 10;
          const b = x(e.to) + BW / 2 - 10;
          const depth = Y + BH + 16 + i * 18;
          return (
            <g key={`a${i}`}>
              <path className="edge" d={`M${a},${Y + BH + 2} V${depth} H${b} V${Y + BH + 6}`} markerEnd={`url(#gf-${graph.id})`} />
              <text className="t-edge" x={(a + b) / 2} y={depth - 4} textAnchor="middle">
                {e.label ?? ''}
              </text>
            </g>
          );
        })}
        {nodes.map((n) => (
          <g key={n.id}>
            <title>{n.description}</title>
            <rect x={x(n.id)} y={Y} width={BW} height={BH} rx={7} fill="var(--panel-2)" stroke="var(--rule)" />
            <text className="t-title" style={{ fontSize: 13.5 }} x={x(n.id) + 10} y={Y + 22}>
              {n.label}
            </text>
            <text className="t-desc" style={{ fontFamily: 'var(--mono)', fontSize: 11 }} x={x(n.id) + 10} y={Y + 42}>
              {n.id}
            </text>
          </g>
        ))}
      </svg>
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
