import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { AnthropicLlm, hasApiKey, PORTS } from '@healer/agent';
import { createHealerApp } from './app.ts';
import { httpShopClient } from './shopLink.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (existsSync(`${root}.env`)) process.loadEnvFile(`${root}.env`);
const dataDir = resolve(root, process.env.HEALER_DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });

let llm: AnthropicLlm | null = null;
const healer = createHealerApp({
  dbPath: join(dataDir, 'healer.db'),
  getLlm: () => (hasApiKey() ? (llm ??= new AnthropicLlm()) : null),
  shop: httpShopClient(`http://localhost:${process.env.SHOP_PORT ?? PORTS.shop}`),
});

serve({ fetch: healer.app.fetch, port: Number(process.env.HEALER_PORT ?? PORTS.healer) }, (info) => {
  console.log(`healer listening on http://localhost:${info.port}`);
  healer.start();
});
