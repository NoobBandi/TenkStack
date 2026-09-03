import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';


/**
 * Which commit this build came from.
 *
 * The one build-time fact worth carrying: the version comes from the backend at
 * runtime, but which commit produced this bundle is knowable only here.
 * Previously kept alongside a version read out of package.json, which was that
 * number's third home -- and when the copy went, `v${undefined}` printed the
 * literal string vundefined where a version belonged.
 *
 * release this is, the commit says which build of it is actually serving you,
 * and only the second can answer "did my deploy land". It is shown on hover, so
 * the visible line stays a version number. `--dirty` is included, so a build
 * made from uncommitted edits admits it.
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
  define: {
    __BUILD__: JSON.stringify(buildStamp()),
  },
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
