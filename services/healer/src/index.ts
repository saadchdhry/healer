import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { AnthropicLlm, hasApiKey, PORTS } from '@healer/agent';
import { createHealerApp } from './app.ts';
import { httpShopClient } from './shopLink.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
mkdirSync(`${root}data`, { recursive: true });

let llm: AnthropicLlm | null = null;
const healer = createHealerApp({
  dbPath: `${root}data/healer.db`,
  getLlm: () => (hasApiKey() ? (llm ??= new AnthropicLlm()) : null),
  shop: httpShopClient(`http://localhost:${PORTS.shop}`),
});

serve({ fetch: healer.app.fetch, port: PORTS.healer }, (info) => {
  console.log(`healer listening on http://localhost:${info.port}`);
  healer.start();
});
