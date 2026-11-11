import type { z } from 'zod';
import { finishModelRun, modelRun, type ChatResult, type JsonResult, type LlmClient, type LlmContent, type LlmRequest, type LlmTool } from './llm.ts';

export interface ScriptedTurn {
  text?: string;
  toolUses?: { name: string; input: Record<string, unknown> }[];
  stopReason?: string;
}

// A test double for LlmClient: replies come from queues, and every request is kept for assertions.
export class ScriptedLlm implements LlmClient {
  readonly requests: (LlmRequest & { tools?: LlmTool[] })[] = [];

  constructor(
    private turns: ScriptedTurn[] = [],
    private values: unknown[] = [],
  ) {}

  push(...turns: ScriptedTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  pushJson(...values: unknown[]): this {
    this.values.push(...values);
    return this;
  }

  async chat(req: LlmRequest & { tools?: LlmTool[] }): Promise<ChatResult> {
    this.requests.push(req);
    const turn = this.turns.shift();
    if (!turn) throw new Error('ScriptedLlm: no scripted turn left');
    const toolUses = (turn.toolUses ?? []).map((t) => ({ id: `toolu_${crypto.randomUUID()}`, ...t }));
    const content: LlmContent = [
      ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
      ...toolUses.map((t) => ({ type: 'tool_use' as const, id: t.id, name: t.name, input: t.input })),
    ];
    const stopReason = turn.stopReason ?? (toolUses.length ? 'tool_use' : 'end_turn');
    const run = modelRun(req, req.role, { model: req.model, system: req.system, messages: req.messages, tools: req.tools });
    finishModelRun(run, { stop_reason: stopReason, content }, req.model, 1000, 100);
    return { stopReason, text: turn.text ?? '', toolUses, content, run };
  }

  async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    this.requests.push(req);
    if (!this.values.length) throw new Error('ScriptedLlm: no scripted value left');
    const value = req.schema.parse(this.values.shift());
    const run = modelRun(req, req.role, { model: req.model, system: req.system, messages: req.messages });
    finishModelRun(run, { stop_reason: 'end_turn', value }, req.model, 1000, 100);
    return { value, run };
  }
}
