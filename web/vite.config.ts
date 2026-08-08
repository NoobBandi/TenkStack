import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // Keeps the frontend origin-relative so no build-time API URL is needed.
      // `changeOrigin` is off on purpose: the backend is local and checks
      // nothing about Host, and rewriting it would only obscure logs.
      '/api': {
        target: 'http://127.0.0.1:8070',
        // SSE dies behind a proxy that buffers; ws:false keeps it on plain HTTP
        // streaming, which is what EventSource actually needs.
        ws: false,
      },
    },
  },
});
