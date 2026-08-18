import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';

/**
 * A Python that stays running, so something can ask it more than one question.
 *
 * The preview panel already runs Python, and cannot be reused for this. It
 * builds a fresh frame per click with the source inlined, boots Pyodide from
 * scratch, and writes the output into its own DOM -- there is no way to get a
 * result back out, and no reason there was: a person reads the output on the
 * screen. An agent cannot. It needs the value returned to it so it can decide
 * what to do next, and it needs the interpreter to still be there for the step
 * after that, since a 12 MB boot per step turns five steps into a minute of
 * loading.
 *
 * So this is one hidden frame, booted once, that answers messages.
 *
 * THE FRAME IS STILL OPAQUE
 *
 * `allow-same-origin` is not in the sandbox list and must never be added. The
 * frame has no origin, which is what stops the code inside it reading this
 * page, its cookies, or the session that opened it. That is also why the parent
 * cannot check `event.origin` -- it arrives as the string "null" from every
 * sandboxed frame, including a hostile one someone else opened. The check that
 * does work is identity: the message came from *this* frame's window or it is
 * ignored.
 *
 * WHAT THE MODEL IS ALLOWED TO ASSUME
 *
 * Nothing about this machine. Python here cannot see the filesystem, the GPU,
 * the models, or the network beyond what the page's CSP already permits. It is
 * a calculator with a standard library and whatever wheels Pyodide carries,
 * which is the entire reason it is safe to let a model drive it without asking
 * permission first.
 */

const PYODIDE_VERSION = '314.0.4';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** Long enough for numpy to load and a real computation to finish; short
 *  enough that a runaway loop does not hold the conversation open. */
const RUN_TIMEOUT_MS = 60_000;

/** Output past this is truncated before it reaches the model. A print inside a
 *  loop can produce megabytes, and the context window is the scarce thing. */
const MAX_OUTPUT_CHARS = 8_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Repr of the last expression, the way a REPL answers. */
  value: string | null;
  /** Formatted traceback when the code raised. */
  error: string | null;
  /** Figures the code drew, as PNG data URIs. Harvested rather than shown in
   *  place: this frame is zero by zero and hidden, so anything matplotlib
   *  rendered into it would be drawn where nobody is looking. */
  images: string[];
  elapsed_ms: number;
  timed_out: boolean;
  truncated: boolean;
}

/**
 * The document the frame runs.
 *
 * Waits for work rather than carrying it: the code arrives by message, so one
 * boot serves every step. stdout and stderr are collected per run instead of
 * being written to a DOM nobody is looking at.
 */
/**
 * Where the frame fetches its CJK font from.
 *
 * An absolute URL because the frame is `srcdoc` and has no base of its own to
 * resolve a relative one against. Taken from the page rather than written down,
 * so it follows the console wherever it is served.
 */
const ORIGIN = typeof window === 'undefined' ? '' : window.location.origin;

const RUNTIME_DOC = `<!doctype html><meta charset="utf-8"><body><script type="module">
  const post = (msg) => parent.postMessage(msg, '*');
  let pyodide = null;
  let out = [], err = [];

  try {
    const { loadPyodide } = await import('${PYODIDE_CDN}pyodide.mjs');
    pyodide = await loadPyodide({
      indexURL: '${PYODIDE_CDN}',
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    post({ kind: 'ready' });
  } catch (error) {
    post({ kind: 'failed', detail: String(error?.message || error) });
  }

  /**
   * Collect whatever was drawn, as PNGs.
   *
   * Agg rather than the interactive canvas backend the visible preview uses:
   * that one appends a canvas to the document, which here is a hidden frame of
   * zero size. Agg renders to memory, which is the only place worth rendering
   * to when the picture has to travel to somebody else's screen.
   *
   * Figures are closed afterwards so the next call starts empty rather than
   * re-sending the last one.
   */
  const HARVEST = [
    'import base64 as _b64, io as _io',
    'import matplotlib as _mpl',
    'import matplotlib.pyplot as _plt',
    // Whatever the code did to the font list, DejaVu goes back on the end of
    // it. Code that wants Chinese tends to name a CJK font and nothing else,
    // and that font has no digits -- so the labels arrive and every number on
    // the axes turns into a box. Appending costs nothing when the list is
    // already right: a fallback chain is only consulted for what the fonts
    // ahead of it lack. Here rather than before the run because the font a
    // glyph is drawn with is decided at savefig, so this still reaches text
    // that was created earlier.
    "_fonts = list(_mpl.rcParams['font.sans-serif'])",
    "if 'DejaVu Sans' not in _fonts:",
    "    _mpl.rcParams['font.sans-serif'] = _fonts + ['DejaVu Sans']",
    '_out = []',
    'for _num in _plt.get_fignums():',
    '    _buf = _io.BytesIO()',
    "    _plt.figure(_num).savefig(_buf, format='png', dpi=110, bbox_inches='tight')",
    '    _out.append(_b64.b64encode(_buf.getvalue()).decode())',
    "_plt.close('all')",
    '_out',
  ].join('\\n');

  /**
   * A CJK font for matplotlib, fetched once and only when something draws.
   *
   * Pyodide's matplotlib carries DejaVu Sans and nothing else, so a chart
   * labelled in Chinese comes out as rows of tofu -- and it does so silently,
   * which is worse than an error because the picture looks finished.
   *
   * Registered rather than substituted: it goes on the front of the sans-serif
   * list, so DejaVu still answers for Latin and the CJK font only supplies what
   * DejaVu lacks. unicode_minus is turned off because this font has no U+2212,
   * and a minus sign is exactly the character a chart cannot afford to lose.
   *
   * Four megabytes, once per boot, and never at all for the runs that do not
   * draw. The browser caches it for a year after that.
   */
  let fontReady = null;
  function ensureFont() {
    if (fontReady) return fontReady;
    fontReady = (async () => {
      const response = await fetch('__ORIGIN__/fonts/cjk.ttf');
      if (!response.ok) throw new Error('font ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      pyodide.FS.writeFile('/cjk.ttf', bytes);
      await pyodide.runPythonAsync([
        'import matplotlib',
        'from matplotlib import font_manager as _fm',
        "_fm.fontManager.addfont('/cjk.ttf')",
        "_name = _fm.FontProperties(fname='/cjk.ttf').get_name()",
        "matplotlib.rcParams['font.sans-serif'] = [_name] + list(matplotlib.rcParams['font.sans-serif'])",
        "matplotlib.rcParams['axes.unicode_minus'] = False",
      ].join('\\n'));
    })().catch((error) => {
      // Reported, not fatal. A chart with tofu labels is still a chart, and
      // failing the run over a font would lose the numbers as well.
      err.push('[font] ' + String(error?.message || error));
      // Not retried: a font that failed once will fail the same way, and
      // trying again per run costs a request each time.
    });
    return fontReady;
  }

  addEventListener('message', async (event) => {
    const { kind, id, code } = event.data || {};
    if (kind !== 'run' || !pyodide) return;

    out = []; err = [];
    const started = performance.now();
    let value = null, failure = null, images = [];
    // Doubled backslashes because this whole document is a template literal:
    // one backslash before a b is an escape for backspace, so a word-boundary
    // regex written the ordinary way arrives here as a control character.
    const draws = /\\bmatplotlib\\b|\\bpyplot\\b|\\bseaborn\\b/.test(code);
    try {
      // Packages come from the code's own imports, so "import numpy" works
      // without anyone having declared numpy anywhere.
      await pyodide.loadPackagesFromImports(code);
      // Set before the code runs: pyplot fixes its backend on import, and
      // choosing one afterwards is quietly ignored.
      if (draws) {
        await pyodide.runPythonAsync('import matplotlib; matplotlib.use("agg")');
        await ensureFont();
      }
      const result = await pyodide.runPythonAsync(code);
      if (result !== undefined && result !== null) value = String(result);
    } catch (error) {
      // A Python exception arrives with its traceback already formatted, and
      // the traceback is the part a model needs to fix its own code.
      failure = String(error?.message || error);
    }

    // Attempted even after a failure: code that plotted and then raised still
    // drew something worth seeing.
    if (draws) {
      try {
        const figures = await pyodide.runPythonAsync(HARVEST);
        const list = figures?.toJs ? figures.toJs() : [];
        images = list.map((b64) => 'data:image/png;base64,' + b64);
        figures?.destroy?.();
      } catch (error) {
        // Reported, not swallowed. Silently dropping this made a failed
        // harvest indistinguishable from code that never drew anything, which
        // is exactly the question worth answering when no picture appears.
        err.push('[figure] ' + String(error?.message || error));
      }
    }

    post({
      kind: 'result', id,
      stdout: out.join('\\n'),
      stderr: err.join('\\n'),
      value, error: failure, images,
      elapsed_ms: Math.round(performance.now() - started),
    });
  });
<\/script></body>`;

type Pending = {
  resolve: (result: RunResult) => void;
  timer: number;
  started: number;
};

interface Runtime {
  /** 'off' until something asks for it -- the boot is 12 MB and most
   *  conversations never need Python at all. */
  state: 'off' | 'booting' | 'ready' | 'failed';
  detail: string | null;
  run: (code: string) => Promise<RunResult>;
  /** Throw the interpreter away. The only way out of an infinite loop, since
   *  Pyodide runs on the frame's own thread and cannot be interrupted. */
  reset: () => void;
}

const RuntimeContext = createContext<Runtime | null>(null);

function clip(text: string): [string, boolean] {
  if (text.length <= MAX_OUTPUT_CHARS) return [text, false];
  return [`${text.slice(0, MAX_OUTPUT_CHARS)}\n…（輸出過長，已截斷）`, true];
}

export function PythonRuntimeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Runtime['state']>('off');
  const [detail, setDetail] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const nextId = useRef(0);
  // Resolved when the frame reports ready, so the first run can wait for the
  // boot instead of racing it.
  const booted = useRef<{ promise: Promise<void>; settle: () => void } | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Identity, not origin: a sandboxed frame has no origin and every one of
      // them reports "null", so the string proves nothing.
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data || {};

      if (data.kind === 'ready') {
        setState('ready');
        booted.current?.settle();
        return;
      }
      if (data.kind === 'failed') {
        setState('failed');
        setDetail(data.detail ?? null);
        booted.current?.settle();
        return;
      }
      if (data.kind !== 'result') return;

      const waiting = pending.current.get(data.id);
      if (!waiting) return;
      pending.current.delete(data.id);
      window.clearTimeout(waiting.timer);

      const [stdout, cutOut] = clip(data.stdout ?? '');
      const [stderr, cutErr] = clip(data.stderr ?? '');
      waiting.resolve({
        stdout, stderr,
        value: data.value ?? null,
        error: data.error ?? null,
        images: Array.isArray(data.images) ? data.images : [],
        elapsed_ms: data.elapsed_ms ?? 0,
        timed_out: false,
        truncated: cutOut || cutErr,
      });
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const teardown = useCallback(() => {
    frame.current?.remove();
    frame.current = null;
    booted.current = null;
    // Anything still waiting will never be answered by a frame that is gone.
    for (const [, waiting] of pending.current) {
      window.clearTimeout(waiting.timer);
      waiting.resolve({
        stdout: '', stderr: '', value: null, images: [],
        error: '執行環境已重設', elapsed_ms: 0, timed_out: true, truncated: false,
      });
    }
    pending.current.clear();
    setState('off');
    setDetail(null);
  }, []);

  const boot = useCallback(() => {
    if (booted.current) return booted.current.promise;

    let settle = () => {};
    const promise = new Promise<void>((resolve) => { settle = resolve; });
    booted.current = { promise, settle };
    setState('booting');

    const el = document.createElement('iframe');
    // The same list the visible preview uses, minus everything it does not
    // need. No allow-same-origin, ever: that is what keeps the frame from
    // reading this page.
    el.setAttribute('sandbox', 'allow-scripts');
    el.setAttribute('srcdoc', RUNTIME_DOC.replace('__ORIGIN__', ORIGIN));
    el.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(el);
    frame.current = el;
    return promise;
  }, []);

  const run = useCallback(async (code: string): Promise<RunResult> => {
    await boot();
    if (!frame.current?.contentWindow) {
      return {
        stdout: '', stderr: '', value: null, images: [],
        error: '執行環境無法啟動', elapsed_ms: 0, timed_out: true, truncated: false,
      };
    }

    const id = `r${nextId.current++}`;
    return new Promise<RunResult>((resolve) => {
      const timer = window.setTimeout(() => {
        pending.current.delete(id);
        // The frame cannot be interrupted, so it is discarded. The next run
        // pays for a fresh boot, which is the price of an infinite loop.
        teardown();
        resolve({
          stdout: '', stderr: '', value: null, images: [],
          error: `執行超過 ${RUN_TIMEOUT_MS / 1000} 秒，已中止`,
          elapsed_ms: RUN_TIMEOUT_MS, timed_out: true, truncated: false,
        });
      }, RUN_TIMEOUT_MS);

      pending.current.set(id, { resolve, timer, started: performance.now() });
      frame.current?.contentWindow?.postMessage({ kind: 'run', id, code }, '*');
    });
  }, [boot, teardown]);

  const value = useMemo<Runtime>(
    () => ({ state, detail, run, reset: teardown }),
    [state, detail, run, teardown],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function usePythonRuntime(): Runtime {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error('usePythonRuntime outside PythonRuntimeProvider');
  return ctx;
}
