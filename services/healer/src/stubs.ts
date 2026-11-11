import type { Hono } from 'hono';

// Routes in the contract that are not built yet answer 501 until they are. Every route is built now.
export const NOT_BUILT: readonly (readonly ['get' | 'post', string])[] = [];

export function registerStubs(app: Hono): void {
  for (const [method, path] of NOT_BUILT) {
    app[method](path, (c) => c.json({ error: 'not_implemented', message: `${method.toUpperCase()} ${path} is not built yet` }, 501));
  }
}
