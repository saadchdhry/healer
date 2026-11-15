import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factoryVersion, type AgentVersion, type Issue } from '@healer/agent';
import { applyChanges, ChangeError, changeSchema, nextTier, preferenceScopeRefusal } from './propose.ts';

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

test('a preference proposal may change only notes about its own customer', () => {
  const marcus = { kind: 'customer' as const, customerId: 'c_marcus' };
  const base: AgentVersion = {
    ...factoryVersion(),
    context: [
      { id: 'note_shop', scope: { kind: 'shop' }, text: 'Refunds within 30 days.', addedInVersion: 0, issueId: null },
      { id: 'note_marcus', scope: marcus, text: 'Call him Marcus.', addedInVersion: 0, issueId: null },
      { id: 'note_ava', scope: { kind: 'customer', customerId: 'c_ava' }, text: 'Call her Ava.', addedInVersion: 0, issueId: null },
    ],
  };
  const preference = { kind: 'preference', scope: marcus } as Issue;
  const refusal = (changes: Parameters<typeof preferenceScopeRefusal>[1], issue = preference) => preferenceScopeRefusal(issue, changes, base);

  assert.equal(refusal([{ surface: 'context', op: 'add', scope: marcus, text: 'Call him Marc.' }]), null);
  assert.equal(refusal([{ surface: 'context', op: 'edit', noteId: 'note_marcus', text: 'Call him Marc.' }]), null);
  assert.equal(refusal([{ surface: 'context', op: 'remove', noteId: 'note_marcus' }]), null);

  assert.equal(
    refusal([{ surface: 'context', op: 'edit', noteId: 'note_marcus', text: 'Call him Marc.' }, { surface: 'context', op: 'edit', noteId: 'note_shop', text: 'Refunds within 30 days of delivery.' }]),
    'Refused without running the eval suite: this issue is a preference of customer c_marcus, so its proposal may only add, edit or remove notes about that customer, but it edits note note_shop, a shop-wide note.',
  );
  assert.match(refusal([{ surface: 'context', op: 'remove', noteId: 'note_ava' }])!, /but it removes note note_ava, a note about customer c_ava\.$/);
  assert.match(refusal([{ surface: 'context', op: 'add', scope: { kind: 'shop' }, text: 'x' }])!, /but it adds a shop-wide note\.$/);
  assert.match(refusal([{ surface: 'harness', op: 'set_system_prompt', systemPrompt: 'x' }, { surface: 'model', op: 'set_model', model: base.model }])!, /but it changes the harness \(set_system_prompt\), and it changes the model \(set_model\)\.$/);

  const failure = { kind: 'failure', scope: marcus } as Issue;
  assert.equal(refusal([{ surface: 'context', op: 'edit', noteId: 'note_shop', text: 'x' }], failure), null, 'only preference issues are held to their customer');
});
