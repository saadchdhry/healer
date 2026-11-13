import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './base.css';

document.title = location.pathname.startsWith('/console') ? 'Healer console' : 'Pocket Meadow';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
