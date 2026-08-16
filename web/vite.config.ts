import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * What is actually deployed, stamped in at build time.
 *
 * Read from git rather than from package.json, because the version that matters
 * here is "which build is serving me right now" -- the console is deployed by
 * running `npm run build` over a checkout, and a hand-maintained version number
 * would only ever be right by accident. `--dirty` is included so a build made
 * from uncommitted edits says so.
 */
function buildStamp(): string {
  try {
    const describe = execSync('git describe --always --dirty', { encoding: 'utf8' }).trim();
    const date = execSync('git log -1 --format=%cd --date=short', { encoding: 'utf8' }).trim();
    return `${describe} · ${date}`;
  } catch {
    // A tarball with no git history still has to build.
    return 'unknown';
  }
}

export default defineConfig({
  define: { __BUILD__: JSON.stringify(buildStamp()) },
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
