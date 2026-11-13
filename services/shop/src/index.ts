import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { AnthropicLlm, hasApiKey, PORTS } from '@healer/agent';
import { createShopApp } from './app.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const dataDir = resolve(root, process.env.HEALER_DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });

let llm: AnthropicLlm | null = null;
const { app } = createShopApp({
  dbPath: join(dataDir, 'shop.db'),
  getLlm: () => (hasApiKey() ? (llm ??= new AnthropicLlm()) : null),
});

serve({ fetch: app.fetch, port: Number(process.env.SHOP_PORT ?? PORTS.shop) }, (info) => {
  console.log(`shop listening on http://localhost:${info.port}`);
});
