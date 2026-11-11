import { Environment, SHOP_NAME } from './env.ts';
import { END, Graph } from './graph.ts';
import { LlmError, type ChatResult, type LlmClient, type LlmMessage } from './llm.ts';
import { predictRoute } from './router.ts';
import { executeTool, TOOL_NAMES, toolDefinitions, type ToolContext } from './tools.ts';
import {
  TIER_MODEL_ID,
  type AgentVersion,
  type ChatTurn,
  type Run,
  type Tier,
  type ToolCallRecord,
  type ToolName,
  type Trace,
  type TraceSource,
} from './types.ts';

export interface RunAgentInput {
  version: AgentVersion;
  env: Environment;
  customerId: string;
  history: ChatTurn[];
  message: string;
  threadId: string;
  source: TraceSource;
  llm: LlmClient;
  onRun?: (run: Run) => void;
  traceId?: string;
  // Orders looked up in earlier traces of the same thread; the lookup guard honours them.
  lookedUpOrderIds?: string[];
}

interface AgentState {
  input: RunAgentInput;
  tools: ToolContext;
  tier: Tier;
  routerDecision: Trace['routerDecision'];
  system: string;
  messages: LlmMessage[];
  modelCalls: number;
  last: ChatResult | null;
  output: string;
  toolCalls: ToolCallRecord[];
  runs: Run[];
}

export const REFUSAL_REPLY = "Sorry, I can't help with that request. Is there anything else about your order I can do?";
export const STEP_LIMIT_REPLY = "Sorry, I wasn't able to finish that just now. Could you try asking again?";

function record(state: AgentState, run: Run): void {
  state.runs.push(run);
  state.input.onRun?.(run);
}

function bullets(texts: string[]): string {
  return texts.map((t) => `- ${t}`).join('\n');
}

const graph = new Graph<AgentState>('support_agent', 'route')
  .node('route', 'Route', 'Pick the model tier: the fixed tier, or ask the trained router when the model is routed.', (s) => {
    const model = s.input.version.model;
    if (model.mode === 'fixed') {
      s.tier = model.tier;
    } else {
      s.routerDecision = predictRoute(model.router, s.input.message);
      s.tier = s.routerDecision.needsStrong ? model.hardTier : model.easyTier;
    }
    return { tier: s.tier, routerDecision: s.routerDecision };
  })
  .node(
    'assemble_context',
    'Assemble context',
    'Build the system prompt from the harness prompt, shop notes, notes for this customer, and who and when it is.',
    (s) => {
      const { version, env, customerId, history, message } = s.input;
      const customer = env.customer(customerId);
      if (!customer) throw new Error(`Unknown customer ${customerId}`);
      const shopNotes = version.context.filter((n) => n.scope.kind === 'shop').map((n) => n.text);
      const customerNotes = version.context
        .filter((n) => n.scope.kind === 'customer' && n.scope.customerId === customerId)
        .map((n) => n.text);
      s.system = [
        version.harness.systemPrompt,
        shopNotes.length ? `Shop notes:\n${bullets(shopNotes)}` : '',
        customerNotes.length ? `Notes about this customer:\n${bullets(customerNotes)}` : '',
        `Today's date is ${env.today}. You are talking with ${customer.name} (customer id ${customer.id}, email ${customer.email}, member since ${customer.memberSince}).`,
      ]
        .filter(Boolean)
        .join('\n\n');
      s.messages = [
        ...history.map((t): LlmMessage => ({ role: t.role === 'customer' ? 'user' : 'assistant', content: t.text })),
        { role: 'user', content: message },
      ];
      return { system: s.system, messageCount: s.messages.length };
    },
  )
  .node('call_model', 'Call model', 'Send the conversation and the enabled tools to the chosen model.', async (s, ctx) => {
    const { version, llm } = s.input;
    s.modelCalls++;
    try {
      s.last = await llm.chat({
        role: 'agent',
        model: TIER_MODEL_ID[s.tier],
        effort: version.model.effort,
        system: s.system,
        messages: [...s.messages],
        tools: toolDefinitions(version.harness.tools),
        parentId: ctx.runId,
      });
    } catch (err) {
      if (err instanceof LlmError) record(s, err.run);
      throw err;
    }
    record(s, s.last.run);
    if (s.last.stopReason === 'max_tokens') throw new Error('The model hit max_tokens');
    s.messages.push({ role: 'assistant', content: s.last.content });
    return { stopReason: s.last.stopReason, toolUses: s.last.toolUses.map((t) => t.name) };
  })
  .node('run_tools', 'Run tools', 'Execute each tool the model asked for against the shop and hand back the results.', (s, ctx) => {
    const results = s.last!.toolUses.map((use) => {
      const startedAt = new Date().toISOString();
      const outcome = executeTool(use.name, use.input, s.tools);
      const run: Run = {
        id: crypto.randomUUID(),
        parentId: ctx.runId,
        kind: 'tool',
        name: use.name,
        startedAt,
        endedAt: new Date().toISOString(),
        input: use.input,
        output: outcome.output,
        ...(outcome.isError ? { error: (outcome.output as { error: string }).error } : {}),
      };
      record(s, run);
      s.toolCalls.push({ runId: run.id, name: use.name as ToolName, input: use.input, output: outcome.output, blockedByGuard: outcome.blockedByGuard });
      return {
        type: 'tool_result' as const,
        tool_use_id: use.id,
        content: JSON.stringify(outcome.output),
        ...(outcome.isError ? { is_error: true } : {}),
      };
    });
    // All results go back in one user message, which keeps parallel tool calls working.
    s.messages.push({ role: 'user', content: results });
    return { results: results.length };
  })
  .node('finish', 'Finish', 'Take the final reply, or a fallback reply when the model refused or ran out of steps.', (s) => {
    const last = s.last!;
    if (last.stopReason === 'refusal') s.output = REFUSAL_REPLY;
    else if (last.stopReason === 'tool_use') s.output = STEP_LIMIT_REPLY;
    else s.output = last.text.trim();
    return { output: s.output };
  })
  .edge('route', 'assemble_context')
  .edge('assemble_context', 'call_model')
  .branch(
    'call_model',
    [
      { to: 'run_tools', label: 'tool calls' },
      { to: 'finish', label: 'final reply' },
    ],
    (s) => (s.last!.stopReason === 'tool_use' && s.last!.toolUses.length ? 'run_tools' : 'finish'),
  )
  .branch(
    'run_tools',
    [
      { to: 'call_model', label: 'steps left' },
      { to: 'finish', label: 'step limit' },
    ],
    (s) => (s.modelCalls < s.input.version.harness.maxSteps ? 'call_model' : 'finish'),
  )
  .edge('finish', END);

export const agentGraphShape = graph.shape();

export async function runAgent(input: RunAgentInput): Promise<Trace> {
  const startedAt = new Date().toISOString();
  const envBefore = input.env.snapshot();
  const { version } = input;
  const state: AgentState = {
    input,
    tools: {
      env: input.env,
      customerId: input.customerId,
      guards: version.harness.guards,
      lookedUp: new Set(input.lookedUpOrderIds ?? []),
      enabled: version.harness.tools.filter((t) => t.enabled).map((t) => t.name),
    },
    tier: version.model.mode === 'fixed' ? version.model.tier : version.model.easyTier,
    routerDecision: null,
    system: '',
    messages: [],
    modelCalls: 0,
    last: null,
    output: '',
    toolCalls: [],
    runs: [],
  };
  let error: string | undefined;
  try {
    await graph.run(state, { maxSteps: 4 + 2 * version.harness.maxSteps, onRun: (run) => record(state, run) });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const modelRuns = state.runs.filter((r) => r.kind === 'model' && r.usage);
  return {
    id: input.traceId ?? crypto.randomUUID(),
    threadId: input.threadId,
    customerId: input.customerId,
    versionId: version.id,
    source: input.source,
    startedAt,
    endedAt: new Date().toISOString(),
    history: input.history,
    input: input.message,
    output: state.output,
    tierUsed: state.tier,
    routerDecision: state.routerDecision,
    runs: state.runs,
    toolCalls: state.toolCalls,
    envBefore,
    envAfter: input.env.snapshot(),
    usage: {
      inputTokens: modelRuns.reduce((n, r) => n + r.usage!.inputTokens, 0),
      outputTokens: modelRuns.reduce((n, r) => n + r.usage!.outputTokens, 0),
      costUsd: modelRuns.reduce((n, r) => n + r.usage!.costUsd, 0),
    },
    ...(error ? { error } : {}),
  };
}

// Order ids the agent saw through get_order or list_orders in earlier traces of a thread.
export function lookedUpOrderIds(traces: Trace[]): string[] {
  const ids = new Set<string>();
  for (const trace of traces) {
    for (const call of trace.toolCalls) {
      if (call.blockedByGuard || (call.output as { error?: string }).error) continue;
      if (call.name === 'get_order') ids.add(call.input.order_id as string);
      if (call.name === 'list_orders') for (const o of call.output as { id: string }[]) ids.add(o.id);
    }
  }
  return [...ids];
}

const FACTORY_TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  list_orders: "List the current customer's orders.",
  get_order: 'Get the full details of an order by its id.',
  issue_refund: 'Issue a refund on an order.',
  cancel_order: 'Cancel an order.',
  update_shipping_address: 'Change the shipping address of an order.',
  escalate_to_human: 'Hand the conversation to a human support colleague.',
};

export function factoryVersion(): AgentVersion {
  return {
    id: 0,
    parentId: null,
    createdAt: '2026-11-11T00:00:00.000Z',
    author: 'factory',
    summary: 'Factory version: small model, short prompt, no shop policy.',
    status: 'live',
    proposalId: null,
    gated: false,
    context: [],
    harness: {
      systemPrompt: `You are the friendly customer support assistant for ${SHOP_NAME}, an online shop selling home and garden goods. Help customers with their orders. Use your tools to look things up and to take actions for the customer. Be warm, clear and helpful, and keep replies short.`,
      tools: TOOL_NAMES.map((name) => ({ name, description: FACTORY_TOOL_DESCRIPTIONS[name], enabled: true })),
      guards: { requireOrderLookupBeforeWrite: false, blockDuplicateRefund: false, refundEscalationThreshold: null },
      maxSteps: 8,
    },
    model: { mode: 'fixed', tier: 'haiku', effort: 'low' },
  };
}
