import { useApi } from '../../lib/hooks.ts';
import { Empty, Q } from '../components/States.tsx';
import { TraceTable } from '../components/TraceTable.tsx';
import { IdLink, Layer, PageHead, RawRun } from '../components/ui.tsx';
import { GraphFlow, TraceRoute } from '../components/GraphFlow.tsx';

export function RunPage() {
  const traces = useApi('GET /api/healer/traces', [{ query: { limit: 50 } }], ['trace', 'verdict']);
  const graphs = useApi('GET /api/healer/graphs', []);
  const latestId = traces.data?.find((t) => t.source !== 'eval')?.id;
  const latest = useApi('GET /api/healer/traces/:id', [{ params: { id: latestId ?? '' } }], [], latestId !== undefined);
  const live = traces.data?.filter((t) => t.source !== 'eval');

  return (
    <>
      <PageHead title="Run">
        The agent handles a customer message, using the live version's context, harness and model. Every reply leaves a trace: the exact inputs, outputs and the
        sequence of every step. Agent failures are about meaning, so they show up in traces and not in ordinary logs.
      </PageHead>
      <Layer title="Conversations arriving from the shop" aside="Newest first, updates live">
        <Q q={traces} what="traces">
          {() =>
            live && live.length ? (
              <TraceTable traces={live} showOutput />
            ) : (
              <Empty>No conversations yet. Chat in the shop front, or send simulated customers from the map page, and each message appears here as it is answered.</Empty>
            )
          }
        </Q>
      </Layer>
      <Layer
        title="The agent graph"
        aside={
          latestId ? (
            <>
              As defined in code, with the route of the latest conversation, trace <IdLink kind="trace" id={latestId} />
            </>
          ) : (
            'As defined in code'
          )
        }
      >
        {latestId ? (
          <Q q={latest} what="the latest trace">
            {(d) => <TraceRoute trace={d.trace} />}
          </Q>
        ) : (
          <Q q={graphs} what="the agent graph">
            {(g) => <GraphFlow graph={g.agent} />}
          </Q>
        )}
      </Layer>
      <Layer title="Raw workings" aside={latestId ? `Model calls in the latest trace, ${latestId}` : undefined} raw>
        {!latestId ? (
          <Empty>The exact prompt and response of the latest model call appear here once a conversation arrives.</Empty>
        ) : (
          <Q q={latest} what="the latest trace">
            {(d) => (
              <>
                {d.trace.runs
                  .filter((r) => r.kind === 'model')
                  .map((r, i) => (
                    <RawRun key={r.id} run={r} title={`Model call ${i + 1}`} open={i === 0} />
                  ))}
              </>
            )}
          </Q>
        )}
      </Layer>
    </>
  );
}
