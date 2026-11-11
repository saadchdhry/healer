import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './base.css';

async function boot() {
  if (import.meta.env.VITE_MOCK === '1') await import('./dev/mock.ts');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
