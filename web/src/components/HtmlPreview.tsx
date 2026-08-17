import { useEffect, useMemo, useState } from 'react';
import Loading from './Loading';

/**
 * Runs a model-written HTML document in an isolated frame.
 *
 * The sandbox attribute deliberately omits `allow-same-origin`. Without it the
 * frame gets an opaque origin, and that single omission is what makes this safe:
 * the console authenticates with an HttpOnly session cookie, and HttpOnly stops
 * scripts *reading* the cookie, not the browser *attaching* it to a request. A
 * same-origin frame could therefore call `fetch('/api/keys', {method:'POST'})`
 * and mint itself a key with the signed-in user's rights. From an opaque origin
 * that request is cross-origin, the CORS allow-list does not contain `null`, and
 * cookies are not sent anyway.
 *
 * Never add `allow-same-origin` here. It is not a convenience flag; it removes
 * the whole boundary.
 */

/**
 * Content-Security-Policy injected into every preview.
 *
 * This used to be `default-src 'none'`, which blocked every remote image, web
 * font and CDN script -- so a page that asked for Chart.js, or Google Fonts, or
 * a placeholder photo, rendered as a broken skeleton with nothing on screen
 * saying why. That is most generated front-end code.
 *
 * What it was buying was not what it looked like it was buying. The boundary
 * here has never been the CSP: it is the missing `allow-same-origin` on the
 * sandbox, which puts this document on an opaque origin with no cookies, no
 * storage, and no reach into the console that framed it. And `unsafe-inline`
 * plus `unsafe-eval` were already granted, so arbitrary script was always going
 * to run -- letting it arrive from a CDN adds a network request, not a
 * capability.
 *
 * So what a strict policy actually cost was the feature, and what it bought was
 * narrower than it appeared: a page could still not read anything of yours, only
 * announce to a remote host that it had been opened. That is a real if small
 * privacy leak, and it is the price of previews that work.
 *
 * The three restrictions kept are the ones no legitimate page needs:
 *
 *   object-src 'none'   no Flash/PDF plugin surfaces
 *   base-uri 'none'     a <base> tag cannot silently repoint every relative URL
 *   form-action 'none'  a form cannot POST what you typed to a remote host,
 *                       which is the one exfiltration route that carries
 *                       something you did not already have
 *
 * upgrade-insecure-requests is there because the console is served over TLS, so
 * an http:// subresource would be blocked as mixed content no matter what this
 * policy said. Upgrading is the difference between an image loading and an
 * error nobody can act on.
 */
const CSP = [
  "default-src https: data: blob:",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  "connect-src https: data: blob:",
  "frame-src https: data: blob:",
  "worker-src blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'upgrade-insecure-requests',
].join('; ');

const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

/**
 * In-memory stand-ins for the storage APIs.
 *
 * An opaque origin has no storage, and reading `window.localStorage` there does
 * not return null -- it throws SecurityError. Generated code reaches for it at
 * the top of a script often enough that this is not an edge case: one
 * `localStorage.getItem('highScore')` in a variable declaration throws before a
 * single event listener is registered, and the whole page renders perfectly
 * while responding to nothing. That failure looks like "the JS is broken"
 * rather than like a permission error, which is what makes it worth shimming.
 *
 * Values live for as long as the frame does, so a re-run starts clean. That is
 * the honest behaviour for a preview: it is a scratch document, not a saved one.
 */
const STORAGE_SHIM = `<script>(function(){
  function memory(){
    var data = Object.create(null);
    return {
      getItem: function(k){ k = String(k);
        return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function(k, v){ data[String(k)] = String(v); },
      removeItem: function(k){ delete data[String(k)]; },
      clear: function(){ data = Object.create(null); },
      key: function(i){ var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      get length(){ return Object.keys(data).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function(name){
    var usable = false;
    try { var s = window[name]; s.getItem('__probe'); usable = true; } catch (e) { usable = false; }
    if (!usable) {
      try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (e) {}
    }
  });
  // document.cookie throws in an opaque origin too, and a script that sets one
  // on load would die the same way.
  try { void document.cookie; } catch (e) {
    var jar = '';
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function(){ return jar; },
        set: function(v){ jar = jar ? jar + '; ' + v : String(v); }
      });
    } catch (e2) {}
  }
})();<\/script>`;

/** A light ground, so a preview that sets no background is not a dark void. */
const BASE = `<style>
  html, body { margin: 0; padding: 0; }
  body { background: #ffffff; color: #111; font: 14px/1.5 system-ui, sans-serif; padding: 12px; }
</style>`;

/**
 * Everything injected ahead of the model's own markup, in order.
 *
 * The charset comes first and is ours rather than the document's. A page's own
 * `<meta charset>` only counts inside the first 1024 bytes, and the shim is
 * long enough to push an existing one past that line -- which on a page of
 * Chinese text is the difference between a preview and a screen of mojibake.
 * A second charset later in the document is harmless; the first one wins.
 */
const PREAMBLE = `<meta charset="utf-8">${META}${STORAGE_SHIM}`;

/**
 * Everything a React block needs to become a page, injected around it.
 *
 * WHY THE CODE IS TRANSPILED IN THE FRAME RATHER THAN SENT AWAY
 *
 * esm.sh/tsx is the one-line answer to running JSX in a browser and it works by
 * posting the source to esm.sh to be compiled. On a console whose entire premise
 * is that the model is local, shipping that model's output to a third party to
 * be readable is not a tradeoff, it is a contradiction. Sucrase is fetched
 * instead and the transform happens here: the library crosses the network, the
 * code does not.
 *
 * WHY IMPORTS ARE REWRITTEN RATHER THAN MAPPED
 *
 * An import map can only name specifiers it knows in advance, and generated
 * React reaches for whatever it likes -- lucide-react, recharts, framer-motion.
 * Rewriting every bare specifier to esm.sh covers all of them with one rule.
 * React itself is pinned and passed as `deps` to everything else, because two
 * copies of React in one page is the "invalid hook call" that looks like a bug
 * in the generated code and is not.
 *
 * React 19 removed its UMD build, so this is not a choice between modules and a
 * script tag; modules are the only way in.
 */
const REACT_VERSION = '19.2.8';
const ESM = 'https://esm.sh';

/**
 * Tailwind, because almost all generated React is written in it and without it
 * the preview is correct and unrecognisable -- unstyled markup reads as broken
 * more readily than an error does.
 */
const TAILWIND = `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"><\/script>`;

/**
 * The bootstrap.
 *
 * Errors are drawn into the page rather than left in the console. A preview that
 * fails silently is the worst of the three outcomes -- worse than an error,
 * worse than nothing -- because it looks like a finished render of an empty
 * design. That was already learned once here, from a tetris page that rendered
 * perfectly and responded to nothing.
 */
const REACT_BOOTSTRAP = `<script type="module">
  const show = (kind, detail) => {
    document.body.innerHTML = '';
    const box = document.createElement('pre');
    box.style.cssText = 'margin:0;padding:16px;font:12px/1.6 ui-monospace,monospace;' +
      'color:#b23;background:#fff5f5;border-left:3px solid #e05c5c;white-space:pre-wrap;';
    box.textContent = kind + '\\n\\n' + detail;
    document.body.appendChild(box);
  };
  window.addEventListener('error', (e) => show('執行時錯誤', e.message));
  window.addEventListener('unhandledrejection', (e) => show('未處理的 Promise', String(e.reason)));

  try {
    const source = document.getElementById('__source').textContent;
    const { transform } = await import('${ESM}/sucrase@3');

    // typescript alongside jsx so a .tsx block does not fail on its annotations.
    let code = transform(source, {
      transforms: ['jsx', 'typescript'],
      jsxRuntime: 'automatic',
      production: true,
    }).code;

    // Bare specifiers -> esm.sh. Runs after the transform so that the runtime
    // import sucrase injects for the automatic JSX runtime is rewritten too.
    const pin = 'react@${REACT_VERSION}';
    code = code.replace(
      /(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(['"])([^'"./][^'"]*)\\2/g,
      (all, lead, q, spec) => {
        let url;
        if (spec === 'react' || spec.startsWith('react/')) url = '${ESM}/' + spec.replace('react', pin);
        else if (spec === 'react-dom' || spec.startsWith('react-dom/'))
          url = '${ESM}/' + spec.replace('react-dom', 'react-dom@${REACT_VERSION}');
        else url = '${ESM}/' + spec + '?deps=' + pin + ',react-dom@${REACT_VERSION}';
        return lead + q + url + q;
      },
    );

    const module = await import(URL.createObjectURL(
      new Blob([code], { type: 'text/javascript' })));

    // Code that mounts itself is left alone; anything else exporting a
    // component is mounted here, which is what a bare component block is.
    if (!/createRoot\\s*\\(|ReactDOM\\.render\\s*\\(/.test(source)) {
      const Component = module.default
        ?? Object.values(module).find((v) => typeof v === 'function');
      if (!Component) {
        show('沒有東西可以掛載', '這段程式碼沒有 export default，也沒有自己呼叫 createRoot。');
      } else {
        const [{ createElement, Component: Base }, { createRoot }] = await Promise.all([
          import('${ESM}/${'react@' + REACT_VERSION}'),
          import('${ESM}/react-dom@${REACT_VERSION}/client'),
        ]);
        // A throw during render would otherwise unmount everything and leave a
        // blank page with the reason only in the console.
        class Boundary extends Base {
          constructor(p) { super(p); this.state = {}; }
          static getDerivedStateFromError(error) { return { error }; }
          render() {
            if (this.state.error) {
              show('元件渲染時丟出例外', String(this.state.error?.stack || this.state.error));
              return null;
            }
            return this.props.children;
          }
        }
        createRoot(document.getElementById('root'))
          .render(createElement(Boundary, null, createElement(Component)));
      }
    }
  } catch (error) {
    show('無法執行這段 React', String(error?.stack || error));
  }
<\/script>`;

/** Wrap a React/JSX block in the document that can run it. */
function buildReactDocument(source: string): string {
  // The parser ends a script block at the first `</script`, whatever it is
  // nested in -- including the text/plain block the source is carried in.
  const carried = source.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head>${PREAMBLE}${BASE}${TAILWIND}</head><body>`
    + `<div id="root"></div>`
    + `<script type="text/plain" id="__source">${carried}<\/script>`
    + `${REACT_BOOTSTRAP}</body></html>`;
}

/**
 * Python, run as CPython compiled to WebAssembly.
 *
 * The alternative was a container on the host, which this machine already has
 * the pieces for and which would be faster and less limited. It was not chosen
 * on security grounds -- a container with no network, no writable filesystem and
 * no privileges is a sound sandbox -- but on what the button means.
 *
 * The run button currently promises one thing: this executes in an isolated
 * frame and cannot reach your machine. HTML and React both keep that promise.
 * Wiring Python to a host container would leave the same button meaning two
 * different things with nothing on screen to say which, and being unable to
 * predict what pressing it does is worse than the risk it would carry. If
 * running something against real files is ever wanted, it should be a different
 * control with a different name.
 *
 * The cost is ~12 MB on the first Python run and no real filesystem or sockets.
 * For "does this snippet work" and "plot this", which is what Python in a chat
 * window is, neither is in the way.
 */
const PYODIDE_VERSION = '314.0.4';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Output is a stream, not a page, so this is a console rather than a document.
 *
 * Packages are resolved from the code's own imports: `loadPackagesFromImports`
 * reads the source and fetches numpy, pandas, matplotlib and the rest before
 * anything runs, which is the difference between a snippet working and a
 * ModuleNotFoundError for the one line nobody was asked about.
 *
 * There is no stop button and does not need to be one. The run button replaces
 * the frame, and a frame that is gone is a Python that has stopped -- which is
 * also the only way out of an infinite loop here, since Pyodide runs on the
 * frame's own thread.
 */
const PYTHON_BOOTSTRAP = `<script type="module">
  const out = document.getElementById('out');
  const status = document.getElementById('status');
  const write = (text, cls) => {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
  };

  try {
    status.textContent = '正在載入 Python 執行環境（首次約 12 MB，之後由瀏覽器快取）…';
    const { loadPyodide } = await import('${PYODIDE_CDN}pyodide.mjs');
    const pyodide = await loadPyodide({
      indexURL: '${PYODIDE_CDN}',
      stdout: (line) => write(line + '\\n'),
      stderr: (line) => write(line + '\\n', 'err'),
    });

    const source = document.getElementById('__source').textContent;

    status.textContent = '正在準備這段程式碼用到的套件…';
    await pyodide.loadPackagesFromImports(source);

    // matplotlib draws into the page rather than a file it cannot write.
    if (/\\bmatplotlib\\b/.test(source)) {
      await pyodide.runPythonAsync(
        'import matplotlib\\n' +
        'matplotlib.use("module://matplotlib_pyodide.html5_canvas_backend")\\n');
    }

    status.textContent = '執行中…';
    const started = performance.now();
    const result = await pyodide.runPythonAsync(source);
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);

    // The value of the last expression, shown the way a REPL would. None is the
    // ordinary case for a script and saying so would be noise.
    if (result !== undefined && result !== null) write(String(result) + '\\n', 'value');

    status.textContent = \`完成・\${elapsed}s\`;
  } catch (error) {
    // A Python exception arrives with its traceback already formatted; showing
    // it whole is more use than the one-line message on the front of it.
    write(String(error?.message || error) + '\\n', 'err');
    status.textContent = '中止';
  }
<\/script>`;

/** The console the Python output is written into. */
const PYTHON_STYLE = `<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: #fbfbfc; }
  #status {
    flex: none; padding: 6px 12px; font: 11px/1.6 ui-monospace, monospace;
    color: #667; border-bottom: 1px solid #e3e3e8; background: #f4f4f6;
  }
  #out {
    flex: 1; margin: 0; padding: 12px; overflow: auto; white-space: pre-wrap;
    font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #111;
  }
  #out .err { color: #b23; }
  #out .value { color: #059; }
  /* matplotlib appends its canvases to the body; keep them inside the flow. */
  body > canvas, body > div.matplotlib { max-width: 100%; margin: 8px 12px; }
</style>`;

function buildPythonDocument(source: string): string {
  const carried = source.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head>${PREAMBLE}${PYTHON_STYLE}</head><body>`
    + `<div id="status">準備中…</div><pre id="out"></pre>`
    + `<script type="text/plain" id="__source">${carried}<\/script>`
    + `${PYTHON_BOOTSTRAP}</body></html>`;
}

/**
 * Wrap the model's source in a complete document.
 *
 * Output comes in two shapes: a whole document starting at <!DOCTYPE or <html,
 * or a bare fragment. A fragment can simply be dropped into a shell, but a whole
 * document already has its own <head>, and nesting it inside another one
 * produces markup the parser silently discards -- so the policy is spliced into
 * the document it already has instead.
 */
function buildDocument(source: string, language: string): string {
  if (language === 'jsx' || language === 'tsx') {
    return buildReactDocument(source);
  }

  if (language === 'python' || language === 'py') {
    return buildPythonDocument(source);
  }

  if (language === 'svg') {
    return `<!doctype html><html><head>${PREAMBLE}${BASE}</head><body>${source}</body></html>`;
  }

  const whole = /<html[\s>]/i.test(source) || /<!doctype\s+html/i.test(source);
  if (!whole) {
    return `<!doctype html><html><head>${PREAMBLE}${BASE}</head><body>${source}</body></html>`;
  }

  // Spliced in as early as the document allows, for two reasons: a CSP delivered
  // after a resource has been requested does not apply to it, and the shim has
  // to be in place before the document's own scripts run.
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head[^>]*>/i, (m) => `${m}${PREAMBLE}`);
  }
  if (/<html[^>]*>/i.test(source)) {
    return source.replace(/<html[^>]*>/i, (m) => `${m}<head>${PREAMBLE}</head>`);
  }
  return `${PREAMBLE}${source}`;
}

interface Props {
  source: string;
  language: string;
  /** Bumped by the run button; used as the frame key to force a fresh document. */
  runId: number;
}

export default function HtmlPreview({ source, language, runId }: Props) {
  const doc = useMemo(() => buildDocument(source, language), [source, language]);
  // Reset on runId, not on mount: pressing run again replaces the frame and
  // the wait starts over, and a stale `true` would hide the second load.
  const [painted, setPainted] = useState(false);
  useEffect(() => setPainted(false), [runId]);

  return (
    <div className="md-preview-stack">
      {/* Over the frame until it loads, not instead of it. A blank white
          rectangle is what a preview looks like both while it is arriving and
          when the code that built it did nothing, and those are very different
          situations to be looking at. Python says so explicitly, because that
          one really is a twelve-megabyte download the first time. */}
      {!painted && (
        <div className="md-preview-wait">
          <Loading
            label={language === 'python' || language === 'py'
              ? '正在載入 Python 執行環境'
              : '正在建立預覽'}
            pattern={language === 'python' || language === 'py' ? 'orbit' : 'drive'}
          />
        </div>
      )}
    <iframe
      key={runId}
      className="md-preview-frame"
      srcDoc={doc}
      onLoad={() => setPainted(true)}
      // allow-scripts runs the code and allow-modals lets alert/confirm work,
      // which a lot of generated demos rely on.
      //
      // allow-forms is here because without it the browser refuses the
      // submission outright, which breaks the ordinary demo that has a form and
      // handles it in JavaScript. Nothing is given away by it: form-action
      // 'none' in the policy above already stops a form reaching any host.
      //
      // allow-popups so that target="_blank" links open, and allow-downloads so
      // a page that generates a file can hand it over.
      //
      // Two are deliberately absent. allow-same-origin would remove the whole
      // boundary -- see the note at the top of this file. And
      // allow-popups-to-escape-sandbox would let a window opened from here be
      // an ordinary page again, which is the same hole through a side door.
      sandbox="allow-scripts allow-modals allow-forms allow-popups allow-downloads"
      referrerPolicy="no-referrer"
      title="預覽"
    />
    </div>
  );
}
