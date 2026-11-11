// Live smoke test against the real API. Costs a few cents. Run: npm run smoke -w @healer/agent
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AnthropicLlm,
  Environment,
  factoryVersion,
  hasApiKey,
  LOOP_MODEL_ID,
  runAgent,
  seedSnapshot,
  TIER_MODEL_ID,
  toolDefinitions,
  type LlmMessage,
  type Run,
} from '../src/index.ts';

const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!hasApiKey()) throw new Error('ANTHROPIC_API_KEY is not set');

const llm = new AnthropicLlm();
const line = (label: string, stop: string, run: Run, extra = '') =>
  console.log(`${label}: stop_reason=${stop} model=${run.model} cost=$${run.usage?.costUsd.toFixed(5)} ${extra}`);

const haiku = TIER_MODEL_ID.haiku;
const system = 'You are a terse assistant.';

const plain = await llm.chat({ role: 'agent', model: haiku, effort: 'low', system, messages: [{ role: 'user', content: 'Say hello in five words.' }] });
line('1 plain text (haiku)', plain.stopReason, plain.run, JSON.stringify(plain.text));

const tools = toolDefinitions(factoryVersion().harness.tools);
const messages: LlmMessage[] = [{ role: 'user', content: 'What is in order PM-1004? Look it up.' }];
const first = await llm.chat({ role: 'agent', model: haiku, effort: 'low', system, messages, tools });
line('2a tool request (haiku)', first.stopReason, first.run, JSON.stringify(first.toolUses));
messages.push({ role: 'assistant', content: first.content });
messages.push({
  role: 'user',
  content: first.toolUses.map((t) => ({
    type: 'tool_result' as const,
    tool_use_id: t.id,
    content: JSON.stringify({ id: 'PM-1004', items: ['Brass watering can', 'Copper plant mister'], status: 'delivered' }),
  })),
});
const second = await llm.chat({ role: 'agent', model: haiku, effort: 'low', system, messages, tools });
line('2b tool answer (haiku)', second.stopReason, second.run, JSON.stringify(second.text));

const Verdict = z.object({ passed: z.boolean(), reason: z.string() });
const judged = await llm.json({
  role: 'judge',
  model: LOOP_MODEL_ID,
  effort: 'low',
  system: 'You grade customer support replies.',
  messages: [{ role: 'user', content: 'Customer: "Where is my order?" Agent: "It shipped on 9 November and should arrive by the 13th." Is the reply helpful?' }],
  schema: Verdict,
});
line('3 structured json (opus)', 'end_turn', judged.run, JSON.stringify(judged.value));

const env = new Environment(seedSnapshot());
const trace = await runAgent({
  version: factoryVersion(),
  env,
  customerId: 'c_diego',
  history: [],
  message: 'Hi, where is my terracotta pot order?',
  threadId: 'smoke',
  source: 'shop',
  llm,
});
const agentModelRuns = trace.runs.filter((r) => r.kind === 'model');
console.log(
  `4 runAgent: error=${trace.error ?? 'none'} tier=${trace.tierUsed} modelCalls=${agentModelRuns.length} tools=${trace.toolCalls.map((t) => t.name).join(',')} cost=$${trace.usage.costUsd.toFixed(5)} models=${[...new Set(agentModelRuns.map((r) => r.model))].join(',')} last_stop=${(agentModelRuns.at(-1)?.output as { stop_reason?: string })?.stop_reason}`,
);
console.log(`  reply: ${JSON.stringify(trace.output)}`);
