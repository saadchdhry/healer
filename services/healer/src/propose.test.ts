import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factoryVersion, type AgentVersion } from '@healer/agent';
import { applyChanges, ChangeError, changeSchema, nextTier } from './propose.ts';

const meta = { id: 1, author: 'loop' as const, summary: 's', proposalId: 'prop_1', issueId: 'iss_1' };

test('context changes: add, edit, remove', () => {
  const v1 = applyChanges(factoryVersion(), [{ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: 'Refunds within 30 days.' }], meta);
  assert.equal(v1.id, 1);
  assert.equal(v1.parentId, 0);
  assert.equal(v1.status, 'candidate');
  assert.equal(v1.context.length, 1);
  assert.deepEqual({ ...v1.context[0]!, id: 'x' }, { id: 'x', scope: { kind: 'shop' }, text: 'Refunds within 30 days.', addedInVersion: 1, issueId: 'iss_1' });

  const noteId = v1.context[0]!.id;
  const v2 = applyChanges(v1, [{ surface: 'context', op: 'edit', noteId, text: 'Refunds within 30 days of delivery.' }], { ...meta, id: 2 });
  assert.equal(v2.context[0]!.text, 'Refunds within 30 days of delivery.');
  assert.equal(v2.context[0]!.addedInVersion, 2);
  assert.equal(v1.context[0]!.text, 'Refunds within 30 days.', 'the base is not mutated');

  const v3 = applyChanges(v2, [{ surface: 'context', op: 'remove', noteId }], { ...meta, id: 3 });
  assert.equal(v3.context.length, 0);
  assert.throws(() => applyChanges(v3, [{ surface: 'context', op: 'remove', noteId }], meta), ChangeError);
});

test('harness changes: prompt, tool, guards', () => {
  const v = applyChanges(
    factoryVersion(),
    [
      { surface: 'harness', op: 'set_system_prompt', systemPrompt: 'Be careful.' },
      { surface: 'harness', op: 'set_tool', name: 'issue_refund', description: 'Look the order up first.' },
      { surface: 'harness', op: 'set_tool', name: 'cancel_order', enabled: false },
      { surface: 'harness', op: 'set_guards', guards: { blockDuplicateRefund: true, refundEscalationThreshold: 150 } },
    ],
    meta,
  );
  assert.equal(v.harness.systemPrompt, 'Be careful.');
  assert.equal(v.harness.tools.find((t) => t.name === 'issue_refund')!.description, 'Look the order up first.');
  assert.equal(v.harness.tools.find((t) => t.name === 'cancel_order')!.enabled, false);
  assert.deepEqual(v.harness.guards, { requireOrderLookupBeforeWrite: false, blockDuplicateRefund: true, refundEscalationThreshold: 150 });
});

test('model change and the tier ladder', () => {
  const base = factoryVersion();
  assert.equal(nextTier(base), 'sonnet');
  const v = applyChanges(base, [{ surface: 'model', op: 'set_model', model: { mode: 'fixed', tier: 'sonnet', effort: 'low' } }], meta);
  assert.deepEqual(v.model, { mode: 'fixed', tier: 'sonnet', effort: 'low' });
  assert.equal(nextTier({ ...base, model: { mode: 'fixed', tier: 'opus', effort: 'low' } } as AgentVersion), null);
});

test('change schema validates hand-written changes', () => {
  assert.equal(changeSchema.safeParse({ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: 'x' }).success, true);
  assert.equal(changeSchema.safeParse({ surface: 'context', op: 'add', scope: { kind: 'customer' }, text: 'x' }).success, false);
  assert.equal(changeSchema.safeParse({ surface: 'harness', op: 'set_tool', name: 'teleport' }).success, false);
  assert.equal(changeSchema.safeParse({ surface: 'model', op: 'set_model', model: { mode: 'fixed', tier: 'giant', effort: 'low' } }).success, false);
});
