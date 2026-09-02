import { isValidElement, memo, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { App as AntApp, Button, Tooltip } from 'antd';
import {
  CheckOutlined, CodeOutlined, CopyOutlined, DownloadOutlined, PlayCircleOutlined,
} from '@ant-design/icons';
import { usePreview } from './preview';
import { detectLanguage } from './detect';
import './markdown.css';

/** Languages the preview frame can render. */
const RUNNABLE = new Set(['html', 'svg', 'jsx', 'tsx', 'python', 'py', 'md', 'markdown']);

/** Fence language to file extension, where they differ or are ambiguous. */
const EXTENSIONS: Record<string, string> = {
  javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
  python: 'py', bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'sh',
  yaml: 'yml', markdown: 'md', rust: 'rs', golang: 'go',
  'c++': 'cpp', csharp: 'cs', ruby: 'rb', kotlin: 'kt',
  dockerfile: 'Dockerfile', text: 'txt', plaintext: 'txt',
};

/**
 * Below this a block is something to read or copy, not a file.
 *
 * A download button on a two-line snippet is a third control competing for the
 * bar and an answer nobody asked for -- copy already covers it. Six lines is
 * roughly where output stops being an illustration and starts being something
 * that wants to live somewhere.
 */
const DOWNLOADABLE_LINES = 6;

/**
 * A name for the downloaded file, taken from the code where the code says one.
 *
 * Generated files very often open with their own path in a comment, and using
 * it is the difference between three files called snippet.py and main.py,
 * models.py and routes.py. Only the first line is considered, and only when it
 * is a comment: a path appearing later is being discussed, not declared.
 */
function declaredName(source: string): string | null {
  const first = source.split('\n', 1)[0].trim();
  const declared = /^(?:\/\/|#|--|;|\/\*|\*)\s*([\w.@/-]+\.[A-Za-z]\w{0,4})\b/.exec(first);
  if (!declared) return null;
  const base = declared[1].split('/').pop();
  return base && base.length <= 64 ? base : null;
}

function fileName(source: string, language: string | undefined): string {
  const ext = language ? (EXTENSIONS[language] ?? language) : 'txt';
  return declaredName(source)
    ?? (ext === 'Dockerfile' ? 'Dockerfile' : `snippet.${ext}`);
}

/**
 * A unified diff, split into rows the renderer can tint.
 *
 * Models emit diffs constantly -- a patch, a review, an edit being proposed --
 * and shading one as if it were source code says nothing about which side of it
 * is which. The line numbers come from the hunk headers where there are any; a
 * bare diff with no `@@` is numbered from one, which is what it is.
 */
interface DiffRow {
  kind: 'add' | 'del' | 'ctx' | 'meta';
  old: number | null;
  cur: number | null;
  text: string;
}

function parseDiff(source: string): DiffRow[] {
  let old = 1;
  let cur = 1;
  return source.split('\n').map((text): DiffRow => {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(text);
    if (hunk) {
      old = Number(hunk[1]);
      cur = Number(hunk[2]);
      return { kind: 'meta', old: null, cur: null, text };
    }
    // `+++`/`---` are file headers, not a one-line insertion and deletion.
    if (/^(?:diff |index |---|\+\+\+|new file|deleted file|similarity |rename )/.test(text)) {
      return { kind: 'meta', old: null, cur: null, text };
    }
    if (text.startsWith('+')) return { kind: 'add', old: null, cur: cur++, text };
    if (text.startsWith('-')) return { kind: 'del', old: old++, cur: null, text };
    return { kind: 'ctx', old: old++, cur: cur++, text };
  });
}

/**
 * Split a written message into its prose and its fenced blocks.
 *
 * A message typed in this console is not Markdown to be rendered -- the
 * composer never showed the writer a heading or a bold run, so producing one
 * after the fact would be showing them something they did not write. The one
 * thing it did show as a block was a fenced block, and that is the one thing
 * carried through here.
 */
export function splitCode(text: string): { text: string; code: boolean }[] {
  if (!text.includes('```')) return [{ text, code: false }];
  const lines = text.split('\n');
  const parts: { text: string; code: boolean }[] = [];
  let buffer: string[] = [];
  let inside = false;

  const flush = (code: boolean) => {
    const run = code ? buffer.join('\n') : buffer.join('\n').replace(/^\n+|\n+$/g, '');
    if (run) parts.push({ text: run, code });
    buffer = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inside) { buffer.push(line); flush(true); } else { flush(false); buffer.push(line); }
      inside = !inside;
    } else {
      buffer.push(line);
    }
  }
  // A fence the writer never closed still reads as code; it is closed here so
  // the renderer sees a block rather than a run of loose text.
  if (inside) { buffer.push('```'); flush(true); } else { flush(false); }
  return parts;
}

/**
 * Name the fences that name nothing, so the same detector decides here as in
 * the composer.
 *
 * highlight.js has an automatic mode and this renderer used it. It was measured
 * when the composer needed the same thing: 5 of 7 on realistic multi-line
 * snippets -- Rust as `ini`, Python as `lua` -- and near-random on a single
 * line, with a relevance score that gave nothing to threshold on. The composer
 * stopped using it; leaving it on here meant a block was coloured one way while
 * being typed and another way once sent, and the second one was the worse
 * guess.
 *
 * Only the rendering is rewritten. The message keeps whatever the writer or the
 * model actually sent; this adds a word to a copy of it on its way to the
 * parser.
 *
 * A block whose language cannot be worked out stays plain, which is the point:
 * no colour beats the wrong colour.
 */
function label(markdown: string): string {
  if (!markdown.includes('```')) return markdown;
  const lines = markdown.split('\n');
  const out = [...lines];

  const fill = (open: number, close: number) => {
    // Already named, by the writer or the model.
    if (lines[open].trim().replace(/^`+/, '').trim()) return;
    const guess = detectLanguage(lines.slice(open + 1, close).join('\n'));
    if (guess) out[open] = `${lines[open].trimEnd()}${guess}`;
  };

  let open = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith('```')) continue;
    if (open === -1) { open = i; } else { fill(open, i); open = -1; }
  }
  // A fence still open is a reply still arriving; it gets named from what has
  // landed so far, and named again as more does.
  if (open !== -1) fill(open, lines.length);
  return out.join('\n');
}

/**
 * Renders assistant output as GitHub-flavoured Markdown.
 *
 * Raw HTML is deliberately not enabled. react-markdown ignores it by default,
 * and model output is not trusted input -- a reply that happens to contain a
 * <script> or an onerror attribute must render as text, not run.
 *
 * Streaming produces partially written Markdown on every token: an unclosed
 * fence, half a table, a dangling list marker. remark parses those without
 * throwing, so the output simply settles as the text arrives.
 */

/**
 * Recover the plain text of a rendered node.
 *
 * Syntax highlighting replaces the code string with a tree of coloured spans,
 * so `String(children)` yields "[object Object],[object Object]…" -- which is
 * what the copy button used to put on the clipboard. The text has to be walked
 * out of the element tree instead.
 */
function toText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (isValidElement(node)) {
    return toText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const { message } = AntApp.useApp();
  const [copied, setCopied] = useState(false);
  const preview = usePreview();
  const language = /language-(\w+)/.exec(className ?? '')?.[1];
  // A patch is not source: shading it as code says nothing about which side of
  // it is which.
  const isDiff = language === 'diff' || language === 'patch';
  const source = toText(children).replace(/\n$/, '');
  // No provider means no panel to send this to, so the button is not offered.
  const runnable = preview !== null && RUNNABLE.has(language ?? '');
  const downloadable = source.split('\n').length >= DOWNLOADABLE_LINES;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access needs a secure context; over plain HTTP it is blocked.
      message.warning('瀏覽器不允許複製，請手動選取');
    }
  };

  /**
   * Hand the block over as a file.
   *
   * A blob URL rather than a data: one, because a data: URL carries the whole
   * file through the address bar and browsers cap that length -- which would
   * fail on exactly the long listings this button exists for. Revoked on the
   * next frame; revoking immediately races the download starting.
   */
  const download = () => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName(source, language);
    link.click();
    requestAnimationFrame(() => URL.revokeObjectURL(url));
  };

  const lines = source.split('\n');
  // A one-liner needs no gutter: numbering a single line is a label saying "1".
  const numbered = lines.length > 1;
  const rows = isDiff ? parseDiff(source) : null;
  const added = rows?.filter((r) => r.kind === 'add').length ?? 0;
  const removed = rows?.filter((r) => r.kind === 'del').length ?? 0;

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-name">
          <CodeOutlined />
          {/* The name the code gives itself, and only that: a block that
              declares no path is not a file, and calling it snippet.txt in the
              header would invent one. The language is what it is instead. */}
          <span>{declaredName(source) ?? language ?? 'text'}</span>
        </span>
        <span className="md-code-actions">
          {isDiff && (
            <span className="md-code-stat">
              <span className="md-code-add">+{added}</span>
              <span className="md-code-del">-{removed}</span>
            </span>
          )}
          {runnable && (
            <Tooltip title="在右側的隔離框架中執行">
              <Button
                type="text"
                size="small"
                icon={<PlayCircleOutlined />}
                onClick={() => preview?.open(source, language ?? 'html')}
              />
            </Tooltip>
          )}
          {downloadable && (
            <Tooltip title={`下載為 ${fileName(source, language)}`}>
              <Button type="text" size="small" icon={<DownloadOutlined />} onClick={download} />
            </Tooltip>
          )}
          <Tooltip title={copied ? '已複製' : '複製'}>
            <Button
              type="text"
              size="small"
              icon={copied ? <CheckOutlined /> : <CopyOutlined />}
              onClick={copy}
            />
          </Tooltip>
        </span>
      </div>
      {/* Nothing runs until the button is pressed, and then it runs in the panel
          at the page edge rather than here. Rendering a reply must never execute
          what is in it -- the code arrives token by token from a model, so
          auto-running would mean running half-written documents too. */}
      <div className="md-code-body">
        {numbered && (
          // Outside the scrolling box, so the numbers stay put while a long
          // line is scrolled. Alignment is by line-height alone: both sides are
          // pinned to the same pixel value rather than a ratio, because 1.55 of
          // 13px and 1.55 of 11px are different numbers and the drift compounds
          // down the block.
          <div className="md-code-gutter" aria-hidden>
            {(rows ?? lines).map((row, i) => (
              <span key={i} className={
                typeof row === 'string' ? undefined : `md-code-n-${row.kind}`
              }>
                {typeof row === 'string'
                  ? i + 1
                  : (row.kind === 'del' ? row.old : row.cur) ?? ''}
              </span>
            ))}
          </div>
        )}
        {rows ? (
          <pre className={numbered ? 'md-code-numbered' : undefined}>
            {rows.map((row, i) => (
              <span key={i} className={`md-code-row md-code-r-${row.kind}`}>
                {row.text || ' '}
              </span>
            ))}
          </pre>
        ) : (
          <pre className={numbered ? 'md-code-numbered' : undefined}>
            <code className={className}>{children}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

function Markdown({ children }: { children: string }) {
  const source = useMemo(() => label(children), [children]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // detect is off: its guesses are the ones `label` was written to
        // replace. ignoreMissing keeps a language name this build does not
        // carry -- powershell and dockerfile are outside lowlight's common set
        // -- from throwing; the block renders plain.
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...props }) => {
            // Inline code has no language class and no newline. The text has to
            // be extracted first: a highlighted tree stringifies to object
            // markers, so the newline test never matched on a fenced block that
            // declared no language.
            const isBlock = /language-/.test(className ?? '') || toText(children).includes('\n');
            return isBlock
              ? <CodeBlock className={className}>{children}</CodeBlock>
              : <code className="md-inline" {...props}>{children}</code>;
          },
          a: ({ children, ...props }) => (
            // Model output can link anywhere; noreferrer keeps the console's
            // URL out of whatever it points at.
            <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
          table: ({ children }) => (
            <div className="md-table-wrap"><table>{children}</table></div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

// Re-rendered on every streamed token otherwise. Parsing is linear in the text,
// so skipping renders where the string is unchanged keeps a long reply cheap.
export default memo(Markdown, (prev, next) => prev.children === next.children);

/**
 * The last block in a reply that is worth showing rather than reading.
 *
 * Used to open the preview without being asked. Only the visual languages:
 * Python's output is text and belongs in the conversation where the question
 * was, so opening a panel to print a number would move the answer away from
 * what asked for it.
 *
 * The last rather than the first, because a reply that shows a wrong version
 * and then a corrected one means the second, and a reply that builds up in
 * pieces means the whole.
 */
const VISUAL = new Set(['html', 'svg', 'jsx', 'tsx', 'md', 'markdown']);

export function lastVisualBlock(
  markdown: string,
): { source: string; language: string } | null {
  // Fences with a language, non-greedy to the closing fence. A block that is
  // never closed is a reply still arriving, and this only runs on finished
  // ones.
  const fence = /```([A-Za-z][\w+-]*)\n([\s\S]*?)```/g;
  let found: { source: string; language: string } | null = null;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(markdown)) !== null) {
    const language = match[1].toLowerCase();
    if (VISUAL.has(language)) found = { source: match[2], language };
  }
  return found;
}
