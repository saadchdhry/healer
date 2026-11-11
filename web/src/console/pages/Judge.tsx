import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Verdict } from '@healer/agent';
import { call } from '../../lib/api.ts';
import { useAction, useApi } from '../../lib/hooks.ts';
import { dateTime } from '../../lib/format.ts';
import { ActionError, Empty, Q } from '../components/States.tsx';
import { useCustomers } from '../components/TraceTable.tsx';
import { CheckList, IdLink, Layer, PageHead, RawRun, Tag, VerdictBadge, checkKindWord } from '../components/ui.tsx';

export function JudgePage() {
  const [sp] = useSearchParams();
  const focusVerdict = sp.get('verdict');
  const focusFinding = sp.get('finding');
  const [filter, setFilter] = useState<'' | 'true' | 'false'>('');
  const rules = useApi('GET /api/healer/rules', []);
  const verdicts = useApi('GET /api/healer/verdicts', [{ query: { passed: filter === '' ? undefined : filter === 'true', limit: 200 } }], ['verdict']);
  const findings = useApi('GET /api/healer/findings', [], ['finding']);
  const { name } = useCustomers();
  const [traceId, setTraceId] = useState('');
  const [result, setResult] = useState<Verdict | null>(null);
  const act = useAction();

  useEffect(() => {
    const target = focusVerdict ?? focusFinding;
    if (!target) return;
    const t = setTimeout(() => document.getElementById(target)?.scrollIntoView({ block: 'center' }), 300);
    return () => clearTimeout(t);
  }, [focusVerdict, focusFinding, verdicts.data, findings.data]);

  const latestJudgeRun = verdicts.data?.find((v) => v.judgeRun)?.judgeRun;

  return (
    <>
      <PageHead title="Judge">
        Was the reply good? Checks that can be done in code run first: policy rules, the end state of the shop's data, and the order of tool calls. A model judge is
        used only where judgement is needed, and customer ratings count as feedback. The judge is a model too, so it can be wrong.
      </PageHead>

      <Layer title="Policy rules" aside="The PRD the agent is never shown">
        <Q q={rules} what="rules">
          {(list) =>
            list.length ? (
              <table className="hc-table">
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="mono hc-muted" style={{ width: 200 }}>
                        {r.id}
                      </td>
                      <td style={{ width: 280 }}>{r.label}</td>
                      <td className="hc-sub">{r.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No policy rules are defined in the healer.</Empty>
            )
          }
        </Q>
      </Layer>

      <Layer
        title="Verdicts"
        aside={
          <span className="hc-seg">
            {(
              [
                ['', 'All'],
                ['false', 'Failed'],
                ['true', 'Passed'],
              ] as const
            ).map(([v, l]) => (
              <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)}>
                {l}
              </button>
            ))}
          </span>
        }
      >
        <Q q={verdicts} what="verdicts">
          {(list) =>
            list.length ? (
              <table className="hc-table">
                <thead>
                  <tr>
                    <th>Verdict</th>
                    <th>Trace</th>
                    <th>Result</th>
                    <th>Checks that failed</th>
                    <th>Judged</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((v) => {
                    const failed = v.checks.filter((c) => !c.passed);
                    return (
                      <tr key={v.id} id={v.id} className={v.id === focusVerdict ? 'is-hl' : undefined}>
                        <td className="mono">{v.id}</td>
                        <td>
                          <IdLink kind="trace" id={v.traceId} />
                        </td>
                        <td>
                          <VerdictBadge state={v.passed ? 'pass' : 'fail'} />
                        </td>
                        <td>
                          {failed.length ? (
                            <div className="hc-stack" style={{ gap: 2 }}>
                              {failed.map((c) => (
                                <span key={c.checkId}>
                                  <Tag>{checkKindWord[c.kind]}</Tag> {c.label}
                                  <span className="hc-muted"> {c.detail}</span>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="hc-muted">None. {v.checks.length} checks passed</span>
                          )}
                        </td>
                        <td className="hc-muted">{dateTime(v.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty>No verdicts yet. Each trace is judged shortly after the shop sends it.</Empty>
            )
          }
        </Q>
      </Layer>

      <Layer title="Asking the same question two ways" aside="Red team findings">
        <Q q={findings} what="findings">
          {(list) =>
            list.length ? (
              <div className="hc-stack">
                {list.map((f) => (
                  <div key={f.id} id={f.id} className="hc-panel" style={f.id === focusFinding ? { borderColor: 'var(--focus)' } : undefined}>
                    <div className="hc-row" style={{ marginBottom: 8 }}>
                      <span className="mono">{f.id}</span>
                      <VerdictBadge state={f.consistent ? 'pass' : 'fail'} label={f.consistent ? 'Answers agree' : 'Answers disagree'} />
                      <span className="hc-muted">{name(f.customerId)}</span>
                      <span className="hc-spacer" />
                      {f.issueId && (
                        <span>
                          Issue <IdLink kind="issue" id={f.issueId} />
                        </span>
                      )}
                    </div>
                    <div className="hc-cols">
                      <div>
                        <p className="hc-muted" style={{ margin: '0 0 2px' }}>
                          Original, <IdLink kind="trace" id={f.original.traceId} />
                        </p>
                        <p style={{ margin: 0 }}>{f.original.message}</p>
                      </div>
                      <div>
                        <p className="hc-muted" style={{ margin: '0 0 2px' }}>
                          Paraphrase, <IdLink kind="trace" id={f.paraphrase.traceId} />
                        </p>
                        <p style={{ margin: 0 }}>{f.paraphrase.message}</p>
                      </div>
                    </div>
                    {f.differences.length > 0 && (
                      <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                        {f.differences.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    )}
                    {f.compareRun && (
                      <div style={{ marginTop: 8 }}>
                        <RawRun run={f.compareRun} title="Comparison call" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Empty>No probes yet. Run a red team probe from the map page to ask questions two ways and compare the answers.</Empty>
            )
          }
        </Q>
      </Layer>

      <Layer title="Re-judge a trace">
        <form
          className="hc-row"
          onSubmit={(e) => {
            e.preventDefault();
            const id = traceId.trim();
            if (id) void act.run(async () => setResult(await call('POST /api/healer/traces/:id/judge', { params: { id } })));
          }}
        >
          <input className="hc-input mono" placeholder="Trace id" value={traceId} onChange={(e) => setTraceId(e.target.value)} />
          <button type="submit" className="hc-btn" disabled={act.busy || !traceId.trim()}>
            {act.busy ? 'Judging…' : 'Judge again'}
          </button>
        </form>
        <ActionError error={act.error} />
        {result && (
          <div className="hc-panel" style={{ marginTop: 10 }}>
            <div className="hc-row" style={{ marginBottom: 8 }}>
              <span className="mono">{result.id}</span> on <IdLink kind="trace" id={result.traceId} /> <VerdictBadge state={result.passed ? 'pass' : 'fail'} />
            </div>
            <CheckList checks={result.checks} />
            {result.judgeRun && (
              <div style={{ marginTop: 8 }}>
                <RawRun run={result.judgeRun} title="Judge" />
              </div>
            )}
          </div>
        )}
      </Layer>

      <Layer title="Raw workings" aside="The judge's own run on the most recent verdict that needed one" raw>
        {latestJudgeRun ? <RawRun run={latestJudgeRun} title="Judge" open /> : <Empty>No verdict has needed the model judge yet. Code checks alone settled them.</Empty>}
      </Layer>
    </>
  );
}
