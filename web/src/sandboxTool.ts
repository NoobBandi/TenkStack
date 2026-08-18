import type { RunResult } from './components/pythonRuntime';
import type { SearchResult, ToolSpec } from './api';

/**
 * The tools the model gets.
 *
 * Python is the one that matters, and the interesting property is not what it
 * does but what it cannot do. The interpreter runs in a frame with no
 * origin -- no filesystem, no host, no session, no way back into this page --
 * which is what makes it defensible to let a model call it without stopping to
 * ask permission each time. A tool that could load a model or delete a file
 * would not have that property, and would need a different answer.
 *
 * The description is written for the model rather than for a reader. Every
 * sentence in it exists because leaving it out produces a specific failure:
 * code that tries to open a file, code that assumes a variable survived from
 * the last call, code that returns a value and prints nothing.
 */

export const MAX_STEPS = 8;

/**
 * Searching and reading, which the sandbox cannot do.
 *
 * A frame with no origin sends `Origin: null` on every request, and almost
 * nothing accepts that -- correctly, since it is what stops a page reading
 * another site on the reader's behalf. So these two run on the backend, which
 * is not a browser, and are separate from Python rather than reachable from
 * inside it.
 *
 * Two tools rather than one that does both. A search returns eight links and
 * most turns need none of them opened: the snippets answer it, or say which
 * single link is worth the twelve thousand characters. Fetching all eight to
 * find that out would spend the context on seven pages nobody wanted.
 */
export const SEARCH_TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: [
        'Search the web and get back titles, URLs and snippets.',
        'Use it for anything that happened recently, anything version-specific,',
        'and anything you would otherwise be recalling rather than knowing.',
        'The snippets are often enough on their own; open a page with',
        'read_page only when they are not.',
        'Each result lists the engines that found it -- two independent engines',
        'agreeing is worth more than one.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_page',
      description: [
        'Fetch one web page and return its visible text.',
        'Only for a URL you already have, normally one web_search returned.',
        'Navigation, scripts and styling are stripped; long pages are cut off',
        'after about twelve thousand characters, which is the top of the page',
        'and is where the answer usually is.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'An http or https URL.' },
        },
        required: ['url'],
      },
    },
  },
];

export const SANDBOX_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'run_python',
    description: [
      'Run Python in a sandboxed CPython (Pyodide) inside the browser and get',
      'its output back. Use it whenever an answer depends on a calculation, a',
      'simulation, parsing, or checking something rather than recalling it.',
      '',
      'The environment:',
      '- The standard library plus about 350 prebuilt packages: numpy, pandas,',
      '  matplotlib, scipy, sympy, pillow, scikit-learn, networkx, statsmodels,',
      '  lxml, opencv and so on. Imports load automatically; just import what',
      '  you need.',
      '- That set is fixed. There is no pip and no micropip install: PyPI does',
      '  not permit downloads from a sandboxed page. If something is missing,',
      '  use a package that is present or write it yourself.',
      '- Nothing with a window: no tkinter, turtle, pygame or any other GUI.',
      '  There is no display here at all, so this is not a missing package but',
      '  an impossible one. To show something visually, draw it with matplotlib',
      '  -- its output is rendered.',
      '- No filesystem, no network, no access to the host machine, its GPUs, its',
      '  models or its files. Do not try to open a path or fetch a URL.',
      '- Each call starts from a clean namespace. Nothing carries over from the',
      '  previous call, so repeat any definitions you still need.',
      '- Print what you want to see. Only stdout, stderr and the value of the',
      '  final expression come back.',
      '- A call is cut off after 60 seconds.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The Python source to execute.',
        },
      },
      required: ['code'],
    },
  },
};

/**
 * Packages a model reaches for that cannot exist here, with the reason.
 *
 * "Not installed" invites "then install it", which is a wasted step and then a
 * second wasted step when pip turns out not to exist either. Saying there is no
 * display ends the line and points somewhere that works.
 */
const IMPOSSIBLE: Record<string, string> = {
  tkinter: '這個環境沒有顯示裝置，GUI 一定跑不起來',
  turtle: '這個環境沒有顯示裝置，GUI 一定跑不起來',
  pygame: '這個環境沒有顯示裝置，GUI 一定跑不起來',
  tkinterdnd2: '這個環境沒有顯示裝置，GUI 一定跑不起來',
  subprocess: '這個環境沒有作業系統可以呼叫',
  socket: '這個環境不能開網路連線',
};

/** The module name out of a ModuleNotFoundError, or null. */
function missingModule(error: string): string | null {
  const match = /No module named ['"]([\w.]+)['"]/.exec(error);
  return match ? match[1].split('.')[0] : null;
}

/**
 * The result, as the model reads it.
 *
 * Plain labelled text rather than JSON. The traceback is the part that matters
 * when something failed and it is already formatted; wrapping it in JSON escapes
 * every newline in it and makes the one thing the model needs to read the
 * hardest thing in the message.
 *
 * Empty sections are omitted rather than sent as `stdout: ""`, which reads as a
 * result rather than as an absence -- and an absence is worth noticing, since
 * code that printed nothing is usually code that forgot to.
 */
export function describeResult(result: RunResult): string {
  const parts: string[] = [];

  if (result.error) {
    parts.push(`錯誤:\n${result.error}`);
    const missing = missingModule(result.error);
    if (missing) {
      const why = IMPOSSIBLE[missing];
      parts.push(
        why
          ? `${missing} 在這裡不可用：${why}。請改用別的方式，不要再嘗試安裝。`
          : `這個環境沒有 ${missing}，而且沒有 pip 或 micropip 可以安裝`
            + '（PyPI 不允許沙箱頁面下載）。請改用內建的 350 個套件之一，'
            + '或自己實作需要的部分。',
      );
    }
  }
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr}`);
  if (result.value !== null) parts.push(`最後一個運算式的值: ${result.value}`);
  if (result.images.length) {
    // Described, not attached. A tool message carries text, so the picture goes
    // to the screen and the model gets told it exists -- enough to talk about
    // what it drew without pretending it can see it.
    parts.push(
      `已產生 ${result.images.length} 張圖表，已經顯示給使用者看了。`
      + '不需要再存檔或重畫，直接說明圖上呈現了什麼即可。',
    );
  }

  if (!parts.length) {
    parts.push('程式碼執行完成，但沒有任何輸出。要看到結果請用 print()。');
  }
  if (result.truncated) {
    parts.push('（輸出過長，已截斷。請減少印出的量。）');
  }
  parts.push(`耗時 ${(result.elapsed_ms / 1000).toFixed(2)}s`);
  return parts.join('\n\n');
}

/** Arguments arrive as a JSON string the model wrote, so it can be malformed.
 *  A parse failure is a fixable mistake and goes back as one. */
export function parseCode(argumentsJson: string): { code: string } | { error: string } {
  try {
    const parsed = JSON.parse(argumentsJson);
    if (typeof parsed?.code !== 'string') {
      return { error: 'run_python 需要一個字串參數 code。' };
    }
    return { code: parsed.code };
  } catch {
    return {
      error: `參數不是合法的 JSON，無法解析：${argumentsJson.slice(0, 200)}`,
    };
  }
}

/**
 * A tool result, as the model reads it.
 *
 * Labelled text rather than JSON for the same reason the Python one is: what
 * matters here is prose -- a snippet, a page, a traceback -- and wrapping prose
 * in JSON escapes every newline in it, making the part worth reading the
 * hardest part to read.
 */
export function describeSearch(
  data: { query: string; results: SearchResult[]; answers: string[] },
): string {
  const parts: string[] = [];
  if (data.answers.length) {
    // An engine's own direct answer -- a definition, a conversion, a date.
    // Worth more than the links, so it goes first.
    parts.push(`直接答案:\n${data.answers.join('\n')}`);
  }
  if (!data.results.length) {
    parts.push(`「${data.query}」沒有搜到結果。換個關鍵字再試。`);
    return parts.join('\n\n');
  }
  parts.push(data.results.map((r, i) => [
    `[${i + 1}] ${r.title}`,
    `    ${r.url}`,
    r.published ? `    ${r.published.slice(0, 10)}` : null,
    r.snippet ? `    ${r.snippet}` : null,
    `    來源引擎: ${r.engines.join(', ') || '未知'}`,
  ].filter(Boolean).join('\n')).join('\n\n'));
  return parts.join('\n\n');
}

export function describePage(
  page: { url: string; title?: string; text: string; truncated?: boolean; note?: string },
): string {
  if (page.note) return `${page.url}\n\n${page.note}`;
  if (!page.text.trim()) {
    return `${page.url}\n\n這一頁沒有可讀的文字，可能是靠 JavaScript 產生內容的網站。`;
  }
  const parts = [page.title ? `${page.title}\n${page.url}` : page.url, page.text];
  if (page.truncated) parts.push('（頁面較長，以上是開頭的部分。）');
  return parts.join('\n\n');
}
