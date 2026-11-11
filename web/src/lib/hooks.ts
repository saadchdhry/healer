import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { RefKind } from '@healer/agent';
import { call, type CallArgs, type Res, type RouteKey } from './api.ts';

type ChangeListener = (kinds: RefKind[]) => void;
export const ChangeBus = createContext<{ subscribe: (fn: ChangeListener) => () => void } | null>(null);

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useApi<K extends RouteKey>(
  key: K,
  args: CallArgs<K>,
  refetchOn: RefKind[] = [],
  enabled = true,
): Loaded<Res<K>> {
  const [data, setData] = useState<Res<K>>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const sig = key + JSON.stringify(args);
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    call(key, ...argsRef.current)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [sig, tick, enabled]);

  const bus = useContext(ChangeBus);
  const kinds = refetchOn.join(',');
  useEffect(() => {
    if (!bus || !kinds) return;
    const wanted = kinds.split(',');
    return bus.subscribe((changed) => {
      if (changed.some((k) => wanted.includes(k))) setTick((t) => t + 1);
    });
  }, [bus, kinds]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading: loading && data === undefined, reload };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}
