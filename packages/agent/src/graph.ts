import type { GraphShape, Run, Trace } from './types.ts';

export const END = '__end__';

export interface NodeContext {
  runId: string;
  step: number;
}

// A node changes the shared state in place; whatever it returns is recorded as its run's output.
export type NodeFn<S> = (state: S, ctx: NodeContext) => unknown | Promise<unknown>;

interface NodeDef<S> {
  id: string;
  label: string;
  description: string;
  fn: NodeFn<S>;
}

type EdgeDef<S> =
  | { kind: 'static'; to: string }
  | { kind: 'conditional'; choose: (state: S) => string; targets: { to: string; label?: string }[] };

export interface RunGraphOptions {
  maxSteps: number;
  parentId?: string | null;
  onRun?: (run: Run) => void;
}

export class Graph<S> {
  private nodes = new Map<string, NodeDef<S>>();
  private edges = new Map<string, EdgeDef<S>>();

  constructor(
    readonly id: string,
    readonly entry: string,
  ) {}

  node(id: string, label: string, description: string, fn: NodeFn<S>): this {
    this.nodes.set(id, { id, label, description, fn });
    return this;
  }

  edge(from: string, to: string): this {
    this.edges.set(from, { kind: 'static', to });
    return this;
  }

  // `choose` must return one of the declared targets, so the drawn shape never lies about the code.
  branch(from: string, targets: { to: string; label?: string }[], choose: (state: S) => string): this {
    this.edges.set(from, { kind: 'conditional', choose, targets });
    return this;
  }

  shape(): GraphShape {
    const edges: GraphShape['edges'] = [];
    for (const [from, edge] of this.edges) {
      if (edge.kind === 'static') edges.push({ from, to: edge.to });
      else for (const t of edge.targets) edges.push({ from, to: t.to, ...(t.label ? { label: t.label } : {}) });
    }
    const nodes = [...this.nodes.values()].map(({ id, label, description }) => ({ id, label, description }));
    return { id: this.id, entry: this.entry, nodes, edges };
  }

  async run(state: S, options: RunGraphOptions): Promise<S> {
    let current = this.entry;
    let step = 0;
    while (current !== END) {
      if (step >= options.maxSteps) throw new Error(`Graph "${this.id}" exceeded ${options.maxSteps} steps`);
      const node = this.nodes.get(current);
      if (!node) throw new Error(`Graph "${this.id}" has no node "${current}"`);
      const run: Run = {
        id: crypto.randomUUID(),
        parentId: options.parentId ?? null,
        kind: 'node',
        name: node.id,
        startedAt: new Date().toISOString(),
        endedAt: '',
        input: { step },
        output: null,
      };
      try {
        run.output = (await node.fn(state, { runId: run.id, step })) ?? null;
      } catch (err) {
        run.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        run.endedAt = new Date().toISOString();
        options.onRun?.(run);
      }
      current = this.next(current, state);
      step++;
    }
    return state;
  }

  private next(from: string, state: S): string {
    const edge = this.edges.get(from);
    if (!edge) throw new Error(`Graph "${this.id}" has no edge out of "${from}"`);
    if (edge.kind === 'static') return edge.to;
    const to = edge.choose(state);
    if (!edge.targets.some((t) => t.to === to)) throw new Error(`Graph "${this.id}": "${from}" chose undeclared "${to}"`);
    return to;
  }
}

export type RouteStep =
  | { n: number; kind: 'edge'; from: string; to: string; label?: string }
  | { n: number; kind: 'tool'; name: string; blocked: boolean };

// Node runs are recorded in the order they ran, and tool runs hang off the run_tools visit that made them.
export function traceRoute(trace: Trace, shape: GraphShape): RouteStep[] {
  const visits = trace.runs.filter((r) => r.kind === 'node');
  const steps: RouteStep[] = [];
  const move = (from: string, to: string) => {
    const label = shape.edges.find((e) => e.from === from && e.to === to)?.label;
    steps.push({ n: steps.length + 1, kind: 'edge', from, to, ...(label ? { label } : {}) });
  };
  visits.forEach((visit, i) => {
    for (const call of trace.toolCalls) {
      if (trace.runs.find((r) => r.id === call.runId)?.parentId !== visit.id) continue;
      steps.push({ n: steps.length + 1, kind: 'tool', name: call.name, blocked: call.blockedByGuard !== null });
    }
    const next = visits[i + 1];
    if (next) move(visit.name, next.name);
    else if (!visit.error && shape.edges.some((e) => e.from === visit.name && e.to === END)) move(visit.name, END);
  });
  return steps;
}
