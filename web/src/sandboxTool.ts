import type { RunResult } from './components/pythonRuntime';
import { bytes } from './components/files/kit';
import type { SandboxStatus, SearchResult, ToolCall, ToolSpec } from './api';

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

/**
 * What a call looks like in the trace before it has run.
 *
 * The heading is the tool's name in the reader's language and the body is the
 * one argument that is the point of it -- the code, the query, the URL. Needed
 * in two places now: dispatch, and the step that reports calls it declined to
 * run, which has to describe them without running them.
 */
export function describeCall(call: ToolCall): { heading: string; shown: string } {
  const name = call.function.name;
  const heading = name === 'web_search' ? '搜尋'
    : name === 'read_page' ? '讀取網頁'
    : 'Python';
  let shown = call.function.arguments;
  try {
    const args = JSON.parse(call.function.arguments);
    shown = args.code ?? args.query ?? args.url ?? shown;
  } catch {
    // Left as the raw arguments, which is what the failure looks like.
  }
  return { heading, shown };
}

/**
 * How many tool calls one answer may make.
 *
 * A live binding rather than a constant: it is a setting now, and the agent
 * loop imports this name directly. ES modules make imported bindings live, so
 * updating it here updates it there without threading a value through every
 * call site. Set once at startup from the server's settings; the default is
 * what it always was, so a console that cannot reach the API behaves as before.
 */
export let MAX_STEPS = 8;

export function setMaxSteps(steps: number): void {
  if (Number.isFinite(steps) && steps > 0) MAX_STEPS = Math.floor(steps);
}

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
        'Navigation, scripts and styling are stripped.',
        '',
        'Give `query` whenever you know what you are after. The page is then',
        'cut into passages and only the ones matching it come back, together',
        'with the opening, which keeps a long page from spending the whole',
        'context on its own introduction. Matching is on words, not meaning:',
        'use the words the page itself would use -- a name, an error string, a',
        'quoted phrase -- rather than a question. Omit it to read from the top,',
        'which is the right thing for "what is this page about".',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'An http or https URL.' },
          query: {
            type: 'string',
            description: 'What to look for in the page. Keywords, not a question.',
          },
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
      '- Chinese, Japanese and Korean already work in matplotlib. A CJK font is',
      '  registered and sits at the front of the sans-serif fallback chain, so',
      '  each character is drawn by the first font that has it: CJK from that',
      '  one, digits and Latin from DejaVu. Do not set font.family or',
      '  font.sans-serif yourself. Naming a CJK font alone is the one',
      '  arrangement that fails -- it has no Latin glyphs, so every number on',
      '  the chart turns into a box.',
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
 * run_python when it runs on the server instead.
 *
 * The same name, because to the model it is the same tool -- and a saved
 * conversation that called run_python should read the same whichever engine
 * answered it. What changes is nearly every fact about the environment, and
 * each of them changes what code a model writes: files are now a way to hand
 * something over rather than an error, state carries over so it should not
 * redefine everything, and an interrupt keeps the variables instead of
 * throwing the interpreter away.
 *
 * The numbers come from the server's settings. Built from them per request
 * rather than once, but the text only changes when an administrator changes a
 * setting, so the server's cache of the prompt prefix survives every step.
 */
export function serverSandboxTool(
  status: Pick<SandboxStatus, 'timeout_s' | 'idle_min'>,
): ToolSpec {
  return {
    type: 'function',
    function: {
      name: 'run_python',
      description: [
        'Run Python in a real CPython 3.13 on Linux, inside an isolated container',
        'that belongs to this conversation, and get its output back. Use it',
        'whenever an answer depends on a calculation, a simulation, parsing, a',
        'generated file, or checking something rather than recalling it.',
        '',
        'The environment:',
        '- It is a sandbox, not the host machine: none of the host\'s files,',
        '  GPUs, models or services are reachable from it.',
        '- The standard library plus these preinstalled packages: numpy, pandas,',
        '  scipy, sympy, mpmath, statsmodels, scikit-learn, networkx, matplotlib,',
        '  seaborn, pillow, opencv-python-headless, scikit-image, openpyxl,',
        '  xlsxwriter, xlrd, pyarrow, tabulate, lxml, beautifulsoup4, html5lib,',
        '  pyyaml, jinja2, markdown, python-dateutil, pytz, tzdata, regex,',
        '  chardet, tqdm, rich, shapely, sqlalchemy, python-docx, python-pptx,',
        '  reportlab, pypdf, qrcode.',
        '- There is no network at all, so pip install cannot work and neither',
        '  can fetching a URL. If something is missing, use a package that is',
        '  present or write it yourself.',
        '- State persists between calls in this conversation: variables,',
        '  imports and files are still there next time, so build on them',
        '  instead of repeating everything. The environment is reset after',
        `  ${status.idle_min} minutes without a call, or if it crashes; you are told`,
        '  when that happened.',
        '- The working directory is /home/sandbox. To give the user a file --',
        '  a spreadsheet, a document, a chart as PNG, a CSV -- write it there',
        '  and mention its file name in your answer: it is offered to them for',
        '  download automatically. Do not print a file\'s contents just to',
        '  deliver it.',
        '- Matplotlib figures are shown to the user automatically. Chinese,',
        '  Japanese and Korean already work in them; do not set font.family or',
        '  font.sans-serif yourself.',
        '- It is Linux, so subprocess and shell commands work. There is no GUI',
        '  and no display: no tkinter, turtle or pygame windows.',
        `- Each call is interrupted after ${status.timeout_s} seconds. Variables`,
        '  survive the interrupt, so a long job can be split across calls.',
        '- Print what you want to see. Only stdout, stderr and the value of the',
        '  final expression come back.',
      ].join('\n'),
      parameters: SANDBOX_TOOL.function.parameters,
    },
  };
}

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

/** The ones with no server answer either: a container has no display. */
const GUI = new Set(['tkinter', 'turtle', 'pygame', 'tkinterdnd2']);

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
export function describeResult(
  result: RunResult, engine: 'browser' | 'server' = 'browser',
): string {
  const parts: string[] = [];

  // First, because it changes how everything after it should be read: a
  // NameError below is this, not a typo, and the remedy is to redefine rather
  // than to debug.
  if (result.reset) {
    parts.push('（執行環境是重新啟動的：之前定義的變數和匯入都不在了，先前的檔案也可能不在。'
      + '需要的東西請重新定義。）');
  }
  if (result.error) {
    parts.push(`錯誤:\n${result.error}`);
    const missing = missingModule(result.error);
    if (missing && engine === 'server') {
      // On the server the reasons are different: subprocess and socket exist
      // (the socket just has nowhere to go), and what is missing is missing
      // because there is no network to install it over.
      parts.push(
        GUI.has(missing)
          ? `${missing} 在這裡不可用：這個環境沒有顯示裝置，GUI 一定跑不起來。請改用別的方式，不要再嘗試安裝。`
          : `這個環境沒有 ${missing}，而且完全沒有網路，pip 裝不了。`
            + '請改用已安裝的套件，或自己實作需要的部分。',
      );
    } else if (missing) {
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
  if (result.interrupted) {
    // Said plainly because the browser engine taught the opposite lesson: there
    // a timeout threw the interpreter away, here it keeps everything.
    parts.push('（執行超過時間上限，已被中斷。變數、匯入和檔案都還在，可以接著用；'
      + '請把工作拆成幾次呼叫，或換一個更快的做法。）');
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

  if (result.files?.length) {
    // Named so the answer can refer to them by name; the download itself is
    // the interface's job, and a model that thinks it must deliver the file
    // will paste its contents or invent a link.
    parts.push(
      '已產生或更新的檔案（已經提供給使用者下載，回答時提到檔名即可，不需要給連結或印出內容）:\n'
      + result.files.map((f) => `- ${f.path} (${bytes(f.size)})`).join('\n'),
    );
  }

  // The reset note alone is not output: code that printed nothing is still
  // worth pointing out after a restart.
  if (parts.length === (result.reset ? 1 : 0)) {
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

export function describePage(page: {
  url: string; title?: string; text: string; truncated?: boolean; note?: string;
  query?: string; matched?: boolean; reason?: string;
  passages_used?: number; passages_total?: number; chars_total?: number;
}): string {
  if (page.note) return `${page.url}\n\n${page.note}`;
  if (!page.text.trim()) {
    return `${page.url}\n\n這一頁沒有可讀的文字，可能是靠 JavaScript 產生內容的網站。`;
  }
  const parts = [page.title ? `${page.title}\n${page.url}` : page.url, page.text];

  // What came back, and what did not. A model that cannot tell a selection from
  // a whole page will not think to ask again with different words -- and asking
  // again is the entire remedy for a lexical match that missed.
  if (page.query && page.matched) {
    parts.push(`（全文約 ${page.chars_total} 字，以上是與「${page.query}」最相關的`
      + ` ${page.passages_used}/${page.passages_total} 段，中間跳過的地方標了 […]。`
      + '要別的部分就換關鍵詞再讀一次。）');
  } else if (page.query && page.reason === 'everywhere') {
    // Rephrasing is the remedy for a miss and a waste of a step for this one.
    parts.push(`（「${page.query}」在這一頁的每一段都出現，挑不出特別相關的部分，`
      + '以上是開頭。要更窄的東西請換一個更具體的詞。）');
  } else if (page.query) {
    parts.push(`（頁面裡找不到「${page.query}」的字眼，以上是開頭的部分。`
      + '換成這一頁自己會用的說法再試一次。）');
  } else if (page.truncated) {
    parts.push('（頁面較長，以上是開頭的部分。給 query 可以直接取相關段落。）');
  }
  return parts.join('\n\n');
}
