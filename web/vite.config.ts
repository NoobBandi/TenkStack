import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The console's own version. package.json is the one place it lives. */
const version = JSON.parse(readFileSync('./package.json', 'utf8')).version as string;

/**
 * Which commit this build came from.
 *
 * Kept alongside the version rather than instead of it: the version says what
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
    __VERSION__: JSON.stringify(`v${version}`),
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
