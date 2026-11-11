import type { Hono } from 'hono';

// Routes not built yet: traffic generation, red teaming and router training. Each answers 501 until it is.
// Their state already has a home in the store: findings, routers() and routerDataset().
export const NOT_BUILT = [
  ['get', '/api/healer/seeds'],
  ['post', '/api/healer/seeds/:id/fire'],
  ['post', '/api/healer/simulate'],
  ['post', '/api/healer/redteam'],
  ['get', '/api/healer/findings'],
  ['post', '/api/healer/model/router/dataset'],
  ['post', '/api/healer/model/router/train'],
  ['post', '/api/healer/model/router/:id/propose'],
] as const;

export function registerStubs(app: Hono): void {
  for (const [method, path] of NOT_BUILT) {
    app[method](path, (c) => c.json({ error: 'not_implemented', message: `${method.toUpperCase()} ${path} is not built yet` }, 501));
  }
}
