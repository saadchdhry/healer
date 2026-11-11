import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ShopApp } from './shop/ShopApp.tsx';
import { ConsoleLayout } from './console/ConsoleLayout.tsx';
import { Home } from './console/pages/Home.tsx';
import { RunPage } from './console/pages/Run.tsx';
import { TracesPage, TraceDetailPage } from './console/pages/Traces.tsx';
import { JudgePage } from './console/pages/Judge.tsx';
import { DiagnosePage, IssuePage } from './console/pages/Diagnose.tsx';
import { ProposePage, ProposalPage } from './console/pages/Propose.tsx';
import { GatePage, GateRunPage } from './console/pages/Gate.tsx';
import { ContextPage } from './console/pages/Context.tsx';
import { HarnessPage } from './console/pages/Harness.tsx';
import { ModelPage } from './console/pages/Model.tsx';
import { EvalsPage, EvalCasePage, EvalRunPage } from './console/pages/Evals.tsx';
import { VersionPage } from './console/pages/Version.tsx';
import { NotFound } from './console/components/States.tsx';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ShopApp />} />
        <Route path="/console" element={<ConsoleLayout />}>
          <Route index element={<Home />} />
          <Route path="run" element={<RunPage />} />
          <Route path="traces" element={<TracesPage />} />
          <Route path="traces/:id" element={<TraceDetailPage />} />
          <Route path="judge" element={<JudgePage />} />
          <Route path="diagnose" element={<DiagnosePage />} />
          <Route path="issues/:id" element={<IssuePage />} />
          <Route path="propose" element={<ProposePage />} />
          <Route path="proposals/:id" element={<ProposalPage />} />
          <Route path="gate" element={<GatePage />} />
          <Route path="gate/:id" element={<GateRunPage />} />
          <Route path="context" element={<ContextPage />} />
          <Route path="harness" element={<HarnessPage />} />
          <Route path="model" element={<ModelPage />} />
          <Route path="evals" element={<EvalsPage />} />
          <Route path="evals/:id" element={<EvalCasePage />} />
          <Route path="eval-runs/:id" element={<EvalRunPage />} />
          <Route path="versions/:id" element={<VersionPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
