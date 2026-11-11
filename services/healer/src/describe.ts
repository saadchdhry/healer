import type { AgentVersion, ChatTurn, CheckResult, Issue, Trace } from '@healer/agent';
import { describeChanges, envChanges } from './policy.ts';

// Plain-text renderings of traces and versions for the judge, diagnose and propose prompts.

const json = (v: unknown) => JSON.stringify(v);

export function conversation(history: ChatTurn[], message: string): string {
  const turns = history.map((t) => `${t.role === 'customer' ? 'Customer' : 'Agent'}: ${t.text}`);
  return [...turns, `Customer: ${message}`].join('\n');
}

// The system prompt the agent actually saw, read from its first model call.
export function agentSystemPrompt(trace: Trace): string | null {
  const first = trace.runs.find((r) => r.kind === 'model' && r.role === 'agent');
  const system = (first?.input as { system?: unknown } | undefined)?.system;
  return typeof system === 'string' ? system : null;
}

export function toolCalls(trace: Trace): string {
  if (!trace.toolCalls.length) return '(no tool calls)';
  return trace.toolCalls
    .map((c, i) => `${i + 1}. ${c.name} ${json(c.input)}\n   result: ${json(c.output)}${c.blockedByGuard ? `\n   (blocked by guard ${c.blockedByGuard})` : ''}`)
    .join('\n');
}

export function changes(trace: Trace): string {
  const lines = describeChanges(envChanges(trace.envBefore, trace.envAfter));
  return lines.length ? lines.map((l) => `- ${l}`).join('\n') : '(no changes)';
}

export function customerLine(trace: Trace): string {
  const c = trace.envBefore.customers.find((x) => x.id === trace.customerId);
  return `Customer: ${c ? `${c.name} (${c.id})` : trace.customerId}. Today's date: ${trace.envBefore.today}.`;
}

export function failedChecks(checks: CheckResult[]): string {
  const failed = checks.filter((c) => !c.passed);
  return failed.map((c) => `- [${c.kind}] ${c.label}: ${c.detail}`).join('\n');
}

// A failed conversation as the diagnose and propose prompts see it.
export function failure(trace: Trace, checks: CheckResult[]): string {
  return [
    customerLine(trace),
    `Agent version: ${trace.versionId}, model tier ${trace.tierUsed}.`,
    '',
    'Conversation:',
    conversation(trace.history, trace.input),
    '',
    'Tool calls:',
    toolCalls(trace),
    '',
    'Changes to the shop records:',
    changes(trace),
    '',
    `Agent reply: ${trace.output || `(none, the run failed: ${trace.error})`}`,
    '',
    'Failed checks:',
    failedChecks(checks),
  ].join('\n');
}

export function version(v: AgentVersion): string {
  const notes = v.context.length
    ? v.context.map((n) => `- [${n.id}] (${n.scope.kind === 'shop' ? 'shop' : `customer ${n.scope.customerId}`}) ${n.text}`).join('\n')
    : '(none)';
  const tools = v.harness.tools.map((t) => `- ${t.name}${t.enabled ? '' : ' (disabled)'}: ${t.description}`).join('\n');
  const model = v.model.mode === 'fixed' ? `${v.model.tier}, effort ${v.model.effort}` : `routed between ${v.model.easyTier} and ${v.model.hardTier}`;
  return [
    `Version ${v.id}.`,
    '',
    'Context notes:',
    notes,
    '',
    'System prompt:',
    v.harness.systemPrompt,
    '',
    'Tools:',
    tools,
    '',
    `Guards (enforced in code): ${json(v.harness.guards)}`,
    `Model: ${model}. Max steps: ${v.harness.maxSteps}.`,
  ].join('\n');
}

export function issue(i: Issue): string {
  const scope = i.scope.kind === 'shop' ? 'shop' : `customer ${i.scope.customerId}`;
  return `[${i.id}] ${i.title}\n  cause ${i.cause}, surface ${i.surface}, scope ${scope}, ${i.traceIds.length} failure(s)\n  ${i.summary}`;
}
