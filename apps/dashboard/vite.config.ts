import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev` serves the dashboard on :5173 and sends API and MCP calls to the gateway in the
// local cluster, so the session cookie and CSRF rules behave exactly as in production.
const gateway = process.env.GATEWAY_URL ?? 'http://app.127.0.0.1.nip.io';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: gateway, changeOrigin: true },
      '/mcp': { target: gateway, changeOrigin: true },
    },
  },
  build: { sourcemap: true },
});
