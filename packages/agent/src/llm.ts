import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { costUsd, tierOfModel } from './pricing.ts';
import type { Effort, LlmRole, Run } from './types.ts';

export type LlmMessage = Anthropic.Beta.BetaMessageParam;
export type LlmTool = Anthropic.Beta.BetaTool;
export type LlmContent = Anthropic.Beta.BetaContentBlockParam[];

export interface LlmRequest {
  role: LlmRole;
  model: string;
  effort: Effort;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  parentId?: string | null;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatResult {
  stopReason: string;
  text: string;
  toolUses: ToolUse[];
  // The assistant turn exactly as returned, to be sent back unchanged in the next request.
  content: LlmContent;
  run: Run;
}

export interface JsonResult<T> {
  value: T;
  run: Run;
}

export interface LlmClient {
  chat(req: LlmRequest & { tools?: LlmTool[] }): Promise<ChatResult>;
  json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>>;
}

// Carries the recorded run so callers can keep the failed call in their trace.
export class LlmError extends Error {
  constructor(
    message: string,
    readonly run: Run,
  ) {
    super(message);
  }
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function modelRun(req: LlmRequest, name: string, input: unknown): Run {
  return {
    id: crypto.randomUUID(),
    parentId: req.parentId ?? null,
    kind: 'model',
    name,
    role: req.role,
    model: req.model,
    startedAt: new Date().toISOString(),
    endedAt: '',
    input,
    output: null,
  };
}

export function finishModelRun(run: Run, output: unknown, model: string, inputTokens: number, outputTokens: number): Run {
  run.endedAt = new Date().toISOString();
  run.output = output;
  run.model = model;
  run.usage = { inputTokens, outputTokens, costUsd: costUsd(model, inputTokens, outputTokens) };
  return run;
}

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async chat(req: LlmRequest & { tools?: LlmTool[] }): Promise<ChatResult> {
    const params = { ...this.baseParams(req), ...(req.tools?.length ? { tools: req.tools } : {}) };
    const response = await this.send(req, params, () => this.client.beta.messages.create(params));
    const toolUses: ToolUse[] = [];
    let text = '';
    for (const block of response.message.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use') toolUses.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
    }
    return {
      stopReason: response.message.stop_reason ?? 'end_turn',
      text,
      toolUses,
      content: response.message.content as LlmContent,
      run: response.run,
    };
  }

  async json<T>(req: LlmRequest & { schema: z.ZodType<T> }): Promise<JsonResult<T>> {
    const base = this.baseParams(req);
    const params = { ...base, output_config: { ...base.output_config, format: betaZodOutputFormat(req.schema) } };
    const { message, run } = await this.send(req, params, () => this.client.beta.messages.parse(params));
    if (message.stop_reason !== 'end_turn' || message.parsed_output == null) {
      run.error = `No structured output (stop_reason ${message.stop_reason})`;
      throw new LlmError(run.error, run);
    }
    return { value: message.parsed_output as T, run };
  }

  private baseParams(req: LlmRequest) {
    // Sonnet and Opus can decline on safety grounds; the server retries on a fallback model instead of returning a bare refusal.
    const fallback = tierOfModel(req.model) === 'haiku' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };
    return {
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: req.messages,
      thinking: { type: 'adaptive' as const, display: 'summarized' as const },
      output_config: { effort: req.effort },
      ...fallback,
    };
  }

  private async send<M extends Anthropic.Beta.BetaMessage>(
    req: LlmRequest,
    params: object,
    call: () => Promise<M>,
  ): Promise<{ message: M; run: Run }> {
    const run = modelRun(req, req.role, JSON.parse(JSON.stringify(params)));
    let message: M;
    try {
      message = await call();
    } catch (err) {
      run.endedAt = new Date().toISOString();
      run.error = err instanceof Error ? err.message : String(err);
      throw new LlmError(run.error, run);
    }
    finishModelRun(run, message, message.model, message.usage.input_tokens, message.usage.output_tokens);
    if (message.stop_reason === 'refusal') run.error = `Refused (${message.stop_details?.category ?? 'no category'})`;
    return { message, run };
  }
}
