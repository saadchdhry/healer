import type { HealerApi, ShopApi } from '@healer/agent';

export type Api = ShopApi & HealerApi;
export type RouteKey = keyof Api;
export type Res<K extends RouteKey> = Api[K]['res'];
export type Body<K extends RouteKey> = Api[K]['body'];
export type Query<K extends RouteKey> = Api[K]['query'];

type PathOf<K> = K extends `${string} ${infer P}` ? P : never;
type ParamNames<P> = P extends `${string}:${infer N}/${infer R}`
  ? N | ParamNames<R>
  : P extends `${string}:${infer N}`
    ? N
    : never;

type ParamsPart<K extends RouteKey> = [ParamNames<PathOf<K>>] extends [never]
  ? {}
  : { params: Record<ParamNames<PathOf<K>>, string | number> };
type BodyPart<K extends RouteKey> = [Body<K>] extends [never] ? {} : { body: Body<K> };
type QueryPart<K extends RouteKey> = [Query<K>] extends [never] ? {} : { query?: Query<K> };

export type CallOpts<K extends RouteKey> = ParamsPart<K> & BodyPart<K> & QueryPart<K>;
export type CallArgs<K extends RouteKey> = {} extends CallOpts<K> ? [opts?: CallOpts<K>] : [opts: CallOpts<K>];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export function buildUrl(key: RouteKey, opts: Record<string, unknown> = {}): string {
  const path = key.slice(key.indexOf(' ') + 1);
  const params = (opts.params ?? {}) as Record<string, string | number>;
  let url = path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(String(params[name])));
  const query = opts.query as Record<string, unknown> | undefined;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  return url;
}

export async function call<K extends RouteKey>(key: K, ...[opts]: CallArgs<K>): Promise<Res<K>> {
  const method = key.slice(0, key.indexOf(' '));
  const o = (opts ?? {}) as Record<string, unknown>;
  let res: Response;
  try {
    res = await fetch(buildUrl(key, o), {
      method,
      headers: o.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'unreachable', 'The service did not answer. Is it running?');
  }
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? null, err.message ?? err.error ?? `Request failed with status ${res.status}`);
  }
  return data as Res<K>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export function isMissingKey(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503 && e.code === 'missing_api_key';
}
