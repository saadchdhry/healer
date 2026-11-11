import type { Lineage, Ref, RefKind } from '@healer/agent';
import type { HealerStore } from './store.ts';

type Node = { kind: RefKind; id: string; expand: boolean };

// The chain around one object: trace ↔ verdict ↔ issue ↔ proposal ↔ gate run ↔ version ↔ eval cases.
// Versions reached from a trace or as a proposal's base are shown but not followed, or every trace
// on a version would pull in every issue fixed by it.
export function lineage(store: HealerStore, kind: RefKind, id: string): Lineage {
  const issues = store.issues.list();
  const proposals = store.proposals.list();
  const evalCases = store.evalCases.list();
  const out: Lineage = { traces: [], verdicts: [], issues: [], proposals: [], gateRuns: [], versions: [], evalCases: [] };
  const seen = new Map<string, boolean>();
  const queue: Node[] = [];

  const visit = (kind: RefKind, id: string | number | null | undefined, expand = true) => {
    if (id === null || id === undefined) return;
    const key = `${kind}:${id}`;
    const prior = seen.get(key);
    if (prior === true || (prior === false && !expand)) return;
    seen.set(key, expand);
    queue.push({ kind, id: String(id), expand });
  };

  const add = (list: Ref[], ref: Ref) => {
    if (!list.some((r) => r.id === ref.id)) list.push(ref);
  };

  if (kind === 'evalRun') visit('version', store.evalRuns.get(id)?.versionId);
  else visit(kind, id);

  while (queue.length) {
    const node = queue.shift()!;
    switch (node.kind) {
      case 'trace': {
        const trace = store.trace(node.id);
        if (!trace) break;
        add(out.traces, { kind: 'trace', id: trace.id, label: `"${trace.input.slice(0, 60)}"` });
        const verdict = store.verdictForTrace(trace.id);
        if (verdict) add(out.verdicts, { kind: 'verdict', id: verdict.id, label: verdict.passed ? 'pass' : 'fail' });
        visit('version', trace.versionId, false);
        if (!node.expand) break;
        for (const i of issues) if (i.traceIds.includes(trace.id)) visit('issue', i.id);
        for (const c of evalCases) if (c.sourceTraceId === trace.id) visit('evalCase', c.id);
        break;
      }
      case 'verdict': {
        const verdict = store.verdict(node.id);
        if (verdict) visit('trace', verdict.traceId);
        break;
      }
      case 'issue': {
        const issue = store.issues.get(node.id);
        if (!issue) break;
        add(out.issues, { kind: 'issue', id: issue.id, label: issue.title });
        for (const t of issue.traceIds) visit('trace', t);
        for (const c of issue.evalCaseIds) visit('evalCase', c);
        for (const p of issue.proposalIds) visit('proposal', p);
        break;
      }
      case 'proposal': {
        const proposal = store.proposals.get(node.id);
        if (!proposal) break;
        add(out.proposals, { kind: 'proposal', id: proposal.id, label: proposal.title });
        visit('issue', proposal.issueId);
        visit('gateRun', proposal.gateRunId);
        visit('version', proposal.baseVersionId, false);
        visit('version', proposal.candidateVersionId, false);
        break;
      }
      case 'gateRun': {
        const gate = store.gateRuns.get(node.id);
        if (!gate) break;
        add(out.gateRuns, { kind: 'gateRun', id: gate.id, label: gate.decision });
        visit('proposal', gate.proposalId);
        break;
      }
      case 'version': {
        const version = store.versions.get(node.id);
        if (!version) break;
        add(out.versions, { kind: 'version', id: String(version.id), label: `v${version.id}: ${version.summary}` });
        if (node.expand) visit('proposal', version.proposalId ?? proposals.find((p) => p.candidateVersionId === version.id)?.id);
        break;
      }
      case 'evalCase': {
        const c = store.evalCases.get(node.id);
        if (!c) break;
        add(out.evalCases, { kind: 'evalCase', id: c.id, label: c.title });
        visit('trace', c.sourceTraceId);
        visit('issue', c.issueId);
        break;
      }
      case 'finding': {
        const f = store.findings.get(node.id);
        if (!f) break;
        visit('trace', f.original.traceId);
        visit('trace', f.paraphrase.traceId);
        visit('issue', f.issueId);
        break;
      }
      case 'evalRun':
        break;
    }
  }
  return out;
}
