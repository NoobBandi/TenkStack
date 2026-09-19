/**
 * Monaco, loaded once and only when a file is opened for editing.
 *
 * Bundled from the npm package rather than fetched from a CDN: this console
 * runs on a LAN that may have no route out, and an editor that needs the
 * internet to appear is no editor. The language workers are Vite workers of
 * our own build, per Monaco's own Vite sample. The whole thing is a separate
 * chunk that the browser fetches on the first edit, so the console's initial
 * load does not carry it.
 */

type Monaco = typeof import('monaco-editor');

let pending: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
  if (!pending) {
    pending = (async () => {
      const [monaco, editor, json, css, html, ts] = await Promise.all([
        import('monaco-editor'),
        import('monaco-editor/editor/editor.worker.js?worker'),
        import('monaco-editor/language/json/json.worker.js?worker'),
        import('monaco-editor/language/css/css.worker.js?worker'),
        import('monaco-editor/language/html/html.worker.js?worker'),
        import('monaco-editor/language/typescript/ts.worker.js?worker'),
      ]);
      window.MonacoEnvironment = {
        getWorker(_: string, label: string) {
          switch (label) {
            case 'json': return new json.default();
            case 'css': case 'scss': case 'less': return new css.default();
            case 'html': case 'handlebars': case 'razor': return new html.default();
            case 'typescript': case 'javascript': return new ts.default();
            default: return new editor.default();
          }
        },
      };

      // The console's own palette: near-black ground, white ink at
      // opacities, the cool hues the charts use for tokens. Defined once;
      // every editor created afterwards names it.
      monaco.editor.defineTheme('tenkstack', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '6b6b6b', fontStyle: 'italic' },
          { token: 'keyword', foreground: 'c79bf0' },
          { token: 'string', foreground: '9ccc8a' },
          { token: 'number', foreground: 'e0a83c' },
          { token: 'type', foreground: '6fd0c4' },
          { token: 'variable', foreground: 'd6d6d6' },
          { token: 'key', foreground: '6ea8fe' },
          { token: 'attribute.name', foreground: '6ea8fe' },
          { token: 'tag', foreground: '6ea8fe' },
        ],
        colors: {
          'editor.background': '#0b0b0b',
          'editor.foreground': '#d6d6d6',
          'editorLineNumber.foreground': '#4a4a4a',
          'editorLineNumber.activeForeground': '#9a9a9a',
          'editor.lineHighlightBackground': '#141414',
          'editor.selectionBackground': '#2b3a55',
          'editorCursor.foreground': '#ffffff',
          'editorIndentGuide.background': '#1e1e1e',
          'editorIndentGuide.activeBackground': '#3a3a3a',
          'editorWidget.background': '#141414',
          'editorWidget.border': '#2a2a2a',
          'scrollbarSlider.background': '#ffffff22',
          'scrollbarSlider.hoverBackground': '#ffffff33',
          'minimap.background': '#0b0b0b',
        },
      });
      return monaco;
    })();
  }
  return pending;
}

/**
 * Monaco's language id for a file suffix. Its built-in tokenizers cover
 * what lands on this machine; the few it lacks fall to the nearest cousin
 * (a Jinja template reads well enough as HTML, a Caddyfile as INI) rather
 * than to plain text.
 */
export function monacoLanguage(suffix: string, name = ''): string {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'caddyfile') return 'ini';
  switch (suffix) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return 'javascript';
    case 'ts': case 'mts': case 'cts': case 'tsx': return 'typescript';
    case 'py': case 'pyi': return 'python';
    case 'json': case 'jsonl': case 'ipynb': return 'json';
    case 'md': case 'markdown': return 'markdown';
    case 'yaml': case 'yml': return 'yaml';
    case 'html': case 'htm': case 'j2': case 'jinja': case 'jinja2': return 'html';
    case 'xml': case 'svg': return 'xml';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'sql': return 'sql';
    case 'c': case 'h': case 'cpp': case 'cc': case 'hpp': case 'cu': return 'cpp';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'sh': case 'bash': case 'zsh': case 'env': return 'shell';
    case 'toml': case 'ini': case 'cfg': case 'conf': case 'properties': case 'service': return 'ini';
    case 'dockerfile': return 'dockerfile';
    case 'java': return 'java';
    case 'php': return 'php';
    case 'rb': return 'ruby';
    case 'lua': return 'lua';
    case 'ps1': return 'powershell';
    case 'bat': case 'cmd': return 'bat';
    case 'r': return 'r';
    case 'swift': return 'swift';
    case 'kt': return 'kotlin';
    case 'graphql': return 'graphql';
    default: return 'plaintext';
  }
}
