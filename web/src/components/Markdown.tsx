import { isValidElement, memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { App as AntApp, Button, Tooltip } from 'antd';
import {
  CheckOutlined, CopyOutlined, DownloadOutlined, PlayCircleOutlined,
} from '@ant-design/icons';
import { usePreview } from './preview';
import './markdown.css';

/** Languages the preview frame can render. */
const RUNNABLE = new Set(['html', 'svg']);

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
function fileName(source: string, language: string | undefined): string {
  const ext = language ? (EXTENSIONS[language] ?? language) : 'txt';
  const first = source.split('\n', 1)[0].trim();
  const declared = /^(?:\/\/|#|--|;|\/\*|\*)\s*([\w.@/-]+\.[A-Za-z]\w{0,4})\b/.exec(first);
  if (declared) {
    const base = declared[1].split('/').pop();
    if (base && base.length <= 64) return base;
  }
  return ext === 'Dockerfile' ? 'Dockerfile' : `snippet.${ext}`;
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

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{language ?? 'text'}</span>
        <span className="md-code-actions">
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
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // ignoreMissing: a model inventing a language name must not throw.
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
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
        {children}
      </ReactMarkdown>
    </div>
  );
}

// Re-rendered on every streamed token otherwise. Parsing is linear in the text,
// so skipping renders where the string is unchanged keeps a long reply cheap.
export default memo(Markdown, (prev, next) => prev.children === next.children);
