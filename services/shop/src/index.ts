import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { AnthropicLlm, hasApiKey, PORTS } from '@healer/agent';
import { createShopApp } from './app.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
mkdirSync(`${root}data`, { recursive: true });

let llm: AnthropicLlm | null = null;
const { app } = createShopApp({
  dbPath: `${root}data/shop.db`,
  getLlm: () => (hasApiKey() ? (llm ??= new AnthropicLlm()) : null),
});

serve({ fetch: app.fetch, port: PORTS.shop }, (info) => {
  console.log(`shop listening on http://localhost:${info.port}`);
});
