import type { AgentVersion, Proposal, Tier } from '@healer/agent';
import { now, type Healer } from './console.ts';
import { reproposeOnLive } from './gate.ts';

// Makes `version` live: deploys it to the shop first, then records it, so the registry never claims a version the shop is not running.
async function goLive(h: Healer, version: AgentVersion): Promise<AgentVersion> {
  const { store } = h;
  const previous = store.liveVersion();
  const live: AgentVersion = { ...version, status: 'live' };
  await h.shop.deploy(live);
  if (previous && previous.id !== live.id) store.versions.put({ ...previous, status: 'superseded' });
  store.versions.put(live);
  return live;
}

export async function approve(h: Healer, proposalId: string): Promise<AgentVersion> {
  const { store } = h;
  const proposal = store.proposals.get(proposalId);
  if (!proposal) throw new Error(`Unknown proposal ${proposalId}`);
  if (proposal.status !== 'awaiting_approval') throw new Error(`Proposal ${proposalId} is ${proposal.status}; only one awaiting approval can be promoted`);
  if (store.liveVersion()?.id !== proposal.baseVersionId) {
    throw new Error(`Proposal ${proposalId} was gated against version ${proposal.baseVersionId}, which is no longer live; discard it and propose again`);
  }
  const live = await goLive(h, store.versions.get(proposal.candidateVersionId)!);
  store.proposals.put({ ...proposal, status: 'promoted' });
  if (proposal.issueId) store.issues.put({ ...store.issues.get(proposal.issueId)!, status: 'fixed', updatedAt: now() });
  h.activity('promote', `Version ${live.id} is live in the shop: ${proposal.title}`, { kind: 'version', id: String(live.id), label: `v${live.id}` });
  h.changed('version', 'proposal', 'issue');
  const waiting = (p: Proposal) => p.baseVersionId === proposal.baseVersionId && (p.status === 'draft' || p.status === 'awaiting_approval');
  reproposeOnLive(h, store.proposals.list().filter(waiting));
  return live;
}

// Manual deployments skip the gate, so they are marked as not gated.
async function deployUngated(h: Healer, from: AgentVersion, summary: string, model: AgentVersion['model']): Promise<AgentVersion> {
  const base = h.store.liveVersion()!;
  const version: AgentVersion = {
    ...structuredClone(from),
    id: h.store.nextVersionId(),
    parentId: base.id,
    createdAt: now(),
    author: 'human',
    summary,
    status: 'live',
    proposalId: null,
    gated: false,
    model,
  };
  const live = await goLive(h, version);
  h.activity('promote', `Version ${live.id} is live in the shop, not gated: ${summary}`, { kind: 'version', id: String(live.id), label: `v${live.id}` });
  h.changed('version');
  return live;
}

export function setTier(h: Healer, tier: Tier): Promise<AgentVersion> {
  const live = h.store.liveVersion()!;
  return deployUngated(h, live, `Model switched to ${tier} by hand`, { mode: 'fixed', tier, effort: live.model.effort });
}

export function rollback(h: Healer, versionId: number): Promise<AgentVersion> {
  const target = h.store.versions.get(versionId);
  if (!target) throw new Error(`Unknown version ${versionId}`);
  return deployUngated(h, target, `Rollback to a copy of version ${versionId}`, target.model);
}
