import { useEffect } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import type { LoopStage } from '@healer/agent';
import { ConsoleProvider, useConsole } from './stream.tsx';
import { modelLabel, usd } from '../lib/format.ts';
import './console.css';

export function ConsoleLayout() {
  useEffect(() => {
    document.title = 'Healer console';
  }, []);
  return (
    <ConsoleProvider>
      <div className="hc">
        <Rail />
        <main className="hc-main">
          <KeyBanner />
          <Outlet />
        </main>
      </div>
    </ConsoleProvider>
  );
}

const loop: { to: string; label: string; stage: LoopStage }[] = [
  { to: 'run', label: 'Run', stage: 'run' },
  { to: 'judge', label: 'Judge', stage: 'judge' },
  { to: 'diagnose', label: 'Diagnose', stage: 'diagnose' },
  { to: 'propose', label: 'Propose', stage: 'propose' },
  { to: 'gate', label: 'Gate', stage: 'gate' },
];

function Rail() {
  const { overview, activeStages, streamOpen, overviewError } = useConsole();
  return (
    <aside className="hc-rail">
      <Link to="/console" className="hc-brand">
        <strong>Healer</strong>
        <span>console</span>
      </Link>
      <nav className="hc-nav" aria-label="Console">
        <ul>
          <li>
            <NavLink to="/console" end>
              <span className="hc-key" />
              Concept map
            </NavLink>
          </li>
        </ul>
      </nav>
      <nav className="hc-nav" aria-label="The loop">
        <p>The loop</p>
        <ul>
          {loop.map((l) => (
            <li key={l.to}>
              <NavLink to={l.to}>
                <span className={`hc-key stage${activeStages.has(l.stage) ? ' on' : ''}`} />
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <nav className="hc-nav" aria-label="What can change">
        <p>What can change</p>
        <ul>
          <li>
            <NavLink to="context">
              <span className="hc-key context" />
              Context
            </NavLink>
          </li>
          <li>
            <NavLink to="harness">
              <span className="hc-key harness" />
              Harness
            </NavLink>
          </li>
          <li>
            <NavLink to="model">
              <span className="hc-key model" />
              Model
            </NavLink>
          </li>
        </ul>
      </nav>
      <nav className="hc-nav" aria-label="Foundations">
        <p>Foundations</p>
        <ul>
          <li>
            <NavLink to="traces">
              <span className="hc-key" />
              Traces
            </NavLink>
          </li>
          <li>
            <NavLink to="evals">
              <span className="hc-key" />
              Eval suite
            </NavLink>
          </li>
        </ul>
      </nav>
      <div className="hc-status">
        <div>
          <span>
            <span className={`hc-dot ${overviewError ? 'bad' : overview?.shopConnected ? 'ok' : overview ? 'bad' : ''}`} />
            Shop
          </span>
          <b>{overviewError ? 'healer down' : !overview ? 'checking' : overview.shopConnected ? 'connected' : 'not reachable'}</b>
        </div>
        <div>
          <span>
            <span className={`hc-dot ${streamOpen ? 'ok' : 'bad'}`} />
            Live updates
          </span>
          <b>{streamOpen ? 'on' : 'off'}</b>
        </div>
        {overview && (
          <>
            <div>
              <span>Live version</span>
              <b>
                <Link className="mono" to={`/console/versions/${overview.liveVersionId}`}>
                  v{overview.liveVersionId}
                </Link>
              </b>
            </div>
            <div>
              <span>Model</span>
              <b>{modelLabel(overview.liveModel).split(',')[0]}</b>
            </div>
            <div>
              <span>Spend</span>
              <b className="mono">{usd(overview.cost.totalUsd)}</b>
            </div>
          </>
        )}
        <div>
          <a href="/" target="_blank" rel="noreferrer">
            Open the shop front
          </a>
        </div>
      </div>
    </aside>
  );
}

function KeyBanner() {
  const { overview } = useConsole();
  if (!overview || overview.apiKeyPresent) return null;
  return (
    <div className="hc-banner" role="status">
      <strong>No API key.</strong>
      <span>
        Every model call is switched off: the shop's agent, the judge, diagnosis, proposals and simulated customers. Add <code>ANTHROPIC_API_KEY</code> to{' '}
        <code>.env</code> and restart the services.
      </span>
    </div>
  );
}
