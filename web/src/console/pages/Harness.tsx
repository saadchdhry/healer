import type { AgentVersion, Guards } from '@healer/agent';
import { useApi } from '../../lib/hooks.ts';
import { dateTime } from '../../lib/format.ts';
import { useConsole } from '../stream.tsx';
import { Empty, Q } from '../components/States.tsx';
import { GraphFlow } from '../components/GraphFlow.tsx';
import { VersionDiff, guardLabel, guardValue } from '../components/VersionDiff.tsx';
import { useCustomers } from '../components/TraceTable.tsx';
import { IdLink, Json, Layer, PageHead, Tag, humanize } from '../components/ui.tsx';

function harnessChanged(v: AgentVersion, parent: AgentVersion | undefined) {
  return !parent || JSON.stringify(v.harness) !== JSON.stringify(parent.harness);
}

export function HarnessPage() {
  const { overview } = useConsole();
  const versions = useApi('GET /api/healer/versions', [], ['version']);
  const graphs = useApi('GET /api/healer/graphs', []);
  const { list: customers } = useCustomers();
  const live = versions.data?.find((v) => v.id === overview?.liveVersionId) ?? versions.data?.find((v) => v.status === 'live');

  return (
    <>
      <PageHead title="Harness" accent="var(--harness)">
        The harness is everything around the model: the system prompt, the tools and how they are described, the guards enforced in tool code, and the loop that runs
        it all. A harness change affects every customer at once, so it costs more trust than a note and is reviewed before it ships.
      </PageHead>
      <Q q={versions} what="versions">
        {(vs) =>
          !live ? (
            <Empty>No version is live. Reset to factory from the map page to deploy version 0.</Empty>
          ) : (
            <>
              <Layer title="System prompt" aside={<>Live version <IdLink kind="version" id={live.id} /></>}>
                <pre className="hc-pre" style={{ maxHeight: 'none' }}>
                  {live.harness.systemPrompt}
                </pre>
              </Layer>
              <div className="hc-cols">
                <Layer title="Tools" aside="As the model sees them">
                  <table className="hc-table">
                    <tbody>
                      {live.harness.tools.map((t) => (
                        <tr key={t.name}>
                          <td className="mono" style={{ width: 190 }}>
                            {t.name}
                          </td>
                          <td>{t.enabled ? <span className="hc-verdict pass">Enabled</span> : <span className="hc-verdict fail">Disabled</span>}</td>
                          <td className="hc-sub">{t.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Layer>
                <Layer title="Guards" aside="Enforced in tool code, not by the model">
                  <table className="hc-table">
                    <tbody>
                      {(Object.keys(live.harness.guards) as (keyof Guards)[]).map((k) => (
                        <tr key={k}>
                          <td>{guardLabel(k)}</td>
                          <td className="mono">{guardValue(k, live.harness.guards[k])}</td>
                        </tr>
                      ))}
                      <tr>
                        <td>Maximum steps per reply</td>
                        <td className="mono">{live.harness.maxSteps}</td>
                      </tr>
                    </tbody>
                  </table>
                </Layer>
              </div>
              <Layer title="The agent graph" aside="As defined in code">
                <Q q={graphs} what="the agent graph">
                  {(g) => <GraphFlow graph={g.agent} />}
                </Q>
              </Layer>
              <Layer title="Version history" aside="Versions that changed the harness, newest first">
                <div className="hc-stack" style={{ gap: 8 }}>
                  {vs
                    .slice()
                    .reverse()
                    .filter((v) => harnessChanged(v, vs.find((p) => p.id === v.parentId)))
                    .map((v) => {
                      const parent = vs.find((p) => p.id === v.parentId);
                      return (
                        <details key={v.id} className="hc-raw" open={v.id === live.id}>
                          <summary>
                            <IdLink kind="version" id={v.id} />
                            <strong>{v.summary}</strong>
                            <Tag>{humanize(v.status)}</Tag>
                            <span className="meta">{dateTime(v.createdAt)}</span>
                          </summary>
                          <div style={{ padding: '0 12px 12px' }}>{parent ? <VersionDiff base={parent} candidate={v} customers={customers} /> : <p className="hc-muted">The factory harness. Nothing to compare against.</p>}</div>
                        </details>
                      );
                    })}
                </div>
              </Layer>
              <Layer title="Raw workings" aside="The live harness, exactly as stored" raw>
                <Json value={live.harness} />
              </Layer>
            </>
          )
        }
      </Q>
    </>
  );
}
