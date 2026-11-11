import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mirrors PORTS in @healer/agent. Importing the package here would make Node load its runtime TypeScript, which strip-only mode cannot parse.
const PORTS = { web: 3000, shop: 4311, healer: 4312 };

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORTS.web,
    strictPort: true,
    proxy: {
      '/api/shop': { target: `http://localhost:${PORTS.shop}`, changeOrigin: true },
      '/api/healer': { target: `http://localhost:${PORTS.healer}`, changeOrigin: true },
    },
  },
});
