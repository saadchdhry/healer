import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActivityEntry, HealerEvent, Job, LoopStage, Overview, RefKind } from '@healer/agent';
import { call } from '../lib/api.ts';
import { ChangeBus, RESYNC } from '../lib/hooks.ts';

interface ConsoleState {
  overview: Overview | null;
  overviewError: unknown;
  activeStages: Set<LoopStage>;
  activity: ActivityEntry[];
  freshActivity: Set<string>;
  jobs: Job[];
  streamOpen: boolean;
  refreshOverview: () => void;
  resync: () => void;
  trackJob: (job: Job) => void;
}

const Ctx = createContext<ConsoleState | null>(null);

export function useConsole(): ConsoleState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConsole outside ConsoleProvider');
  return c;
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<unknown>(null);
  const [activeStages, setActiveStages] = useState<Set<LoopStage>>(new Set());
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [freshActivity, setFresh] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [streamOpen, setStreamOpen] = useState(false);
  const listeners = useRef(new Set<(k: RefKind[]) => void>());

  const refreshOverview = () => {
    call('GET /api/healer/overview')
      .then((o) => {
        setOverview(o);
        setActiveStages(new Set(o.activeStages));
        setOverviewError(null);
      })
      .catch(setOverviewError);
  };

  const upsertJob = (job: Job) =>
    setJobs((list) => {
      const i = list.findIndex((j) => j.id === job.id);
      if (i === -1) return [job, ...list];
      const next = list.slice();
      next[i] = job;
      return next;
    });

  const resync = () => {
    refreshOverview();
    call('GET /api/healer/activity', { query: { limit: 60 } }).then(setActivity, () => undefined);
    call('GET /api/healer/jobs').then(setJobs, () => undefined);
  };

  useEffect(() => {
    let es: EventSource | null = null;
    let hadGap = false;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const onMessage = (msg: MessageEvent<string>) => {
      const ev = JSON.parse(msg.data) as HealerEvent;
      switch (ev.type) {
        case 'overview':
          setOverview(ev.overview);
          setActiveStages(new Set(ev.overview.activeStages));
          break;
        case 'stage':
          setActiveStages((s) => {
            const next = new Set(s);
            if (ev.state === 'started') next.add(ev.stage);
            else next.delete(ev.stage);
            return next;
          });
          break;
        case 'activity':
          setActivity((a) => [ev.entry, ...a.filter((x) => x.id !== ev.entry.id)].slice(0, 200));
          setFresh((f) => new Set(f).add(ev.entry.id));
          break;
        case 'job':
          upsertJob(ev.job);
          break;
        case 'changed':
          for (const fn of listeners.current) fn(ev.kinds);
          refreshOverview();
          break;
      }
    };

    const disconnect = () => {
      es?.close();
      es = null;
      hadGap = true;
      setStreamOpen(false);
      if (!closed && retry === undefined) retry = setTimeout(connect, 3000);
    };

    function connect() {
      retry = undefined;
      es = new EventSource('/api/healer/stream');
      es.onopen = () => {
        setStreamOpen(true);
        setOverviewError(null);
        resync();
        // After a gap, every open page refetches what it shows so nothing missed while disconnected stays stale.
        if (hadGap) for (const fn of listeners.current) fn(RESYNC);
        hadGap = false;
      };
      es.onerror = () => {
        refreshOverview();
        disconnect();
      };
      es.onmessage = onMessage;
    }

    refreshOverview();
    connect();
    // The dev proxy keeps the browser's end of the stream open when the healer dies, so a quiet stream is checked by hand.
    const watchdog = setInterval(() => {
      call('GET /api/healer/overview').then(
        (o) => {
          setOverview(o);
          setOverviewError(null);
        },
        (e: unknown) => {
          setOverviewError(e);
          disconnect();
        },
      );
    }, 5000);
    return () => {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(retry);
      es?.close();
    };
  }, []);

  const bus = useMemo(
    () => ({
      subscribe: (fn: (k: RefKind[]) => void) => {
        listeners.current.add(fn);
        return () => void listeners.current.delete(fn);
      },
    }),
    [],
  );

  const value: ConsoleState = { overview, overviewError, activeStages, activity, freshActivity, jobs, streamOpen, refreshOverview, resync, trackJob: upsertJob };
  return (
    <Ctx.Provider value={value}>
      <ChangeBus.Provider value={bus}>{children}</ChangeBus.Provider>
    </Ctx.Provider>
  );
}
