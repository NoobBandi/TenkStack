import type { RunResult } from './components/pythonRuntime';
import type { ToolSpec } from './api';

/**
 * The one tool the model gets: a Python that cannot reach anything.
 *
 * One tool rather than a set, because the interesting property here is not what
 * the tool does but what it cannot do. The interpreter runs in a frame with no
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
