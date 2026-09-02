import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Image, Select, Space, Tooltip, Typography } from 'antd';
import {
  ClearOutlined, CloseOutlined, CodeOutlined, FileTextOutlined,
  HistoryOutlined, PaperClipOutlined, SendOutlined, SlidersOutlined,
  StopOutlined
} from '@ant-design/icons';
import type { ModelCapabilities, ModelInfo } from '../api';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/** Extensions read as plain text and pasted in as a fenced block. This path
 *  works with any model, because the file never leaves the text domain. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'log', 'sql', 'sh', 'bash', 'zsh', 'fish', 'py', 'js',
  'ts', 'tsx', 'jsx', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'rb',
  'php', 'swift', 'lua', 'vim', 'dockerfile', 'makefile', 'html', 'css', 'scss',
  'xml', 'svg', 'diff', 'patch', 'env',
]);

/** Formats that hold text but need parsing before a model can read them. */
const NEEDS_EXTRACTION = new Set(['pdf', 'docx', 'doc', 'pptx', 'xlsx', 'odt', 'epub']);

const MAX_IMAGE_BYTES = 8 << 20;
const MAX_TEXT_BYTES = 512 << 10;

/**
 * Message composer with live code-fence shading.
 *
 * A real <textarea> is kept rather than a contenteditable rich editor: IME
 * composition (注音, 拼音, kana) is reliable in a textarea and routinely broken
 * in contenteditable, and this box is typed in Chinese daily. So instead of
 * replacing the control, a backdrop behind it paints a background over the
 * lines that sit inside a ``` fence.
 *
 * The backdrop renders the same text, transparent, so it wraps identically --
 * shading has to follow soft-wrapped lines, which a per-line-height overlay
 * could not do.
 *
 * The controls live inside the field's border rather than on a row beneath it.
 * That is the whole visual idea here: one bordered object that tracks
 * focus-within, so the model picker and the attach button read as part of the
 * act of writing rather than as a toolbar that happens to sit nearby. The
 * textarea keeps its own full-width row instead of sharing one with the
 * controls -- this box is typed into in paragraphs and pasted into with code,
 * so a single-line composer that grows would be wrong for it.
 */


/** Typography must be identical in both layers or the shading drifts. */
const SHARED: React.CSSProperties = {
  margin: 0,
  // The shell adds 6 of its own; 10 here keeps the text off the border
  // without the doubled inset a full 12 would give.
  padding: 10,
  fontSize: 14,
  lineHeight: 1.6,
  fontFamily: 'inherit',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  border: '1px solid transparent',
  boxSizing: 'border-box',
};

interface Segment {
  text: string;
  code: boolean;
}

/**
 * Split on fence lines, with each fenced region coming out as one run.
 *
 * One run per region rather than one per line. The backdrop draws a run as a
 * block with a bleed around it, and three abutting blocks -- opening fence,
 * body, closing fence -- overlapped their bleeds into bright seams across the
 * middle of what is meant to read as a single box.
 *
 * The newlines that split() removed are not put back between runs: the block
 * boxes are the line breaks now, and emitting both would double every one.
 * Inside a run they are kept, so a run is character-for-character what that
 * stretch of the textarea holds.
 */
function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  let inside = false;
  let buffer: string[] = [];

  const flush = (code: boolean) => {
    if (!buffer.length) return;
    const run = buffer.join('\n');
    const last = segments[segments.length - 1];
    if (last && last.code === code) last.text += `\n${run}`;
    else segments.push({ text: run, code });
    buffer = [];
  };

  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      // The fence line itself belongs to the block, opening or closing.
      flush(inside);
      buffer = [line];
      flush(true);
      inside = !inside;
    } else {
      buffer.push(line);
    }
  }
  flush(inside);

  return segments;
}

/** Whether the caret sits inside an unclosed fence. */
function insideFence(text: string, caret: number): boolean {
  const before = text.slice(0, caret);
  const fences = before.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
  return fences % 2 === 1;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  /** Undefined while the model list is still loading. */
  capabilities?: ModelCapabilities;
  images: string[];
  onImagesChange: (images: string[]) => void;
  models: ModelInfo[];
  model?: string;
  onModelChange: (id: string) => void;
  onClear: () => void;
  canClear: boolean;
  onToggleSettings: () => void;
  settingsOpen: boolean;
  /** Whether the model may call the sandbox. Only offered when the model
   *  reports tool support -- a template without one silently ignores the tools
   *  and the button would promise something that never happens. */
  agent: boolean;
  onAgentChange: (on: boolean) => void;
  onToggleHistory: () => void;
  historyOpen: boolean;
}

export default function Composer({
  value, onChange, onSend, onStop, streaming, disabled,
  capabilities, images, onImagesChange,
  models, model, onModelChange, onClear, canClear,
  onToggleSettings, settingsOpen, agent, onAgentChange, onToggleHistory, historyOpen,
}: Props) {
  const { message: toast } = AntApp.useApp();
  const filePicker = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const [inCode, setInCode] = useState(false);

  // The backdrop does not scroll on its own; it has to follow the textarea.
  const syncScroll = useCallback(() => {
    if (backdrop.current && textarea.current) {
      backdrop.current.scrollTop = textarea.current.scrollTop;
    }
  }, []);

  const syncCaret = useCallback(() => {
    const el = textarea.current;
    if (el) setInCode(insideFence(el.value, el.selectionStart));
  }, []);

  // Grow with the content instead of showing a scrollbar at three lines.
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
    if (backdrop.current) backdrop.current.style.height = el.style.height;
  }, [value]);

  const insertAtCaret = (before: string, after = '') => {
    const el = textarea.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const selected = value.slice(start, end);
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + before.length + selected.length;
      el.setSelectionRange(caret, caret);
      syncCaret();
    });
  };

  const readAsText = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('讀取失敗'));
      reader.readAsText(file);
    });

  const readAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('讀取失敗'));
      reader.readAsDataURL(file);
    });

  const attach = async (files: FileList | File[]) => {
    const nextImages: string[] = [];

    for (const file of Array.from(files)) {
      const extension = (file.name.split('.').pop() ?? '').toLowerCase();
      const isImage = file.type.startsWith('image/');

      if (isImage) {
        if (!capabilities?.vision) {
          toast.warning(`${file.name}：這個模型沒有載入視覺投影檔，無法讀圖`);
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          toast.warning(`${file.name} 超過 ${MAX_IMAGE_BYTES >> 20} MiB`);
          continue;
        }
        nextImages.push(await readAsDataUrl(file));
        continue;
      }

      if (NEEDS_EXTRACTION.has(extension)) {
        // Said plainly rather than silently attaching bytes the model cannot
        // read: a PDF sent as text is noise, and a quiet failure looks like
        // the model ignoring the document.
        toast.warning(`${file.name}：${extension.toUpperCase()} 需要先轉成文字，目前不支援直接讀取`);
        continue;
      }

      if (!TEXT_EXTENSIONS.has(extension) && !file.type.startsWith('text/')) {
        toast.warning(`${file.name}：不是文字檔，無法附加`);
        continue;
      }

      if (file.size > MAX_TEXT_BYTES) {
        toast.warning(`${file.name} 超過 ${MAX_TEXT_BYTES >> 10} KiB，請只貼需要的片段`);
        continue;
      }

      // Text files go straight into the message as a fenced block. Any model
      // can read that -- it needs no multimodality at all.
      const body = await readAsText(file);
      const language = TEXT_EXTENSIONS.has(extension) ? extension : '';
      insertAtCaret(`\n\`\`\`${language}\n// ${file.name}\n${body}\n\`\`\`\n`);
    }

    if (nextImages.length) onImagesChange([...images, ...nextImages]);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length) {
      event.preventDefault();
      void attach(files);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget;

    if (event.key === 'Enter') {
      // An IME uses Enter to accept a candidate. Sending on that keystroke
      // fires off half-typed Chinese, which is the kind of bug that only shows
      // up for the people who actually use the app.
      if (composing || event.nativeEvent.isComposing) return;

      if (event.shiftKey) return; // explicit newline

      // Inside a fence, Enter means newline -- code is multi-line by nature,
      // and requiring Shift for every line would make the block unusable.
      if (insideFence(el.value, el.selectionStart)) return;

      event.preventDefault();
      onSend();
      return;
    }

    if (event.key === 'Tab' && insideFence(el.value, el.selectionStart)) {
      event.preventDefault();
      insertAtCaret('  ');
      return;
    }

    // Typing the third backtick opens a block and closes it in one go, with the
    // caret placed on the empty line between the fences.
    if (event.key === '`') {
      const start = el.selectionStart;
      if (start >= 2 && value.slice(start - 2, start) === '``' && !insideFence(value, start)) {
        event.preventDefault();
        const next = `${value.slice(0, start - 2)}\`\`\`\n\n\`\`\`${value.slice(el.selectionEnd)}`;
        onChange(next);
        requestAnimationFrame(() => {
          el.focus();
          const caret = start - 2 + 4;
          el.setSelectionRange(caret, caret);
          syncCaret();
        });
      }
    }
  };

  const segments = segment(value);
  const canSend = (value.trim().length > 0 || images.length > 0) && !disabled;

  return (
    <div>
      <div className="composer-shell">
        {/* Thumbnails sit inside the shell, above the text, so an attached
            image reads as part of the message being written rather than as a
            separate tray parked underneath it. */}
        {images.length > 0 && (
          <Space wrap size={6} style={{ paddingInline: 4, paddingTop: 2 }}>
            {images.map((src, index) => (
              <div key={index} style={{ position: 'relative' }}>
                <Image src={src} width={56} height={56}
                       style={{ objectFit: 'cover', borderRadius: 8 }} />
                <Button
                  size="small" type="primary" danger shape="circle" icon={<CloseOutlined />}
                  style={{ position: 'absolute', top: -6, right: -6, minWidth: 18, width: 18, height: 18 }}
                  onClick={() => onImagesChange(images.filter((_, i) => i !== index))}
                />
              </div>
            ))}
          </Space>
        )}

        <div style={{ position: 'relative' }}>
          <div
            ref={backdrop}
            aria-hidden
            style={{
              ...SHARED,
              position: 'absolute', inset: 0, overflow: 'hidden',
              color: 'transparent', pointerEvents: 'none',
            }}
          >
            {/* Blocks, not inline spans.
                An inline background hugs the text it sits on, so a fenced block
                came out as one ragged chip per line and the ``` line -- being
                short -- read as the only thing shaded. A block fills the width,
                which is what a code region looks like.

                The segments are line-aligned by construction, so the newlines
                between them are dropped: the block boxes are the line breaks,
                and emitting both would double every one of them.

                The font is deliberately not changed here. This layer only works
                while it wraps character-for-character the way the textarea does,
                and the textarea cannot set a different font for one range of its
                own text -- so shading is what says "code", not the typeface. */}
            {segments.map((seg, index) => (
              <div
                key={index}
                style={seg.code ? {
                  background: 'rgba(128,128,128,0.20)',
                  borderRadius: 4,
                  boxShadow: '0 0 0 4px rgba(128,128,128,0.20)',
                } : undefined}
              >
                {/* A run ending in a newline renders no box for that last empty
                    line unless something occupies it. */}
                {seg.text}{'​'}
              </div>
            ))}
          </div>

          <textarea
            ref={textarea}
            value={value}
            disabled={disabled}
            onChange={(e) => { onChange(e.target.value); syncCaret(); }}
            onScroll={syncScroll}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            placeholder="輸入訊息…  ``` 開啟程式碼區塊，Enter 送出，Shift+Enter 換行"
            rows={3}
            style={{
              ...SHARED,
              position: 'relative',
              width: '100%',
              minHeight: 92,
              resize: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'inherit',
              display: 'block',
            }}
          />
        </div>

        {/* Left of the divide is what this message will be -- what is attached
            to it, which model answers it, whether the model may run code.
            Right of it is the view and the act of sending. */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          paddingInline: 2, paddingBottom: 1,
        }}>
          <Tooltip title={capabilities?.vision
            ? '附加檔案或圖片，圖片也可直接貼上'
            : '附加文字或程式碼檔。這個模型沒有載入視覺投影檔，無法讀圖'}>
            <Button type="text" className="composer-btn"
                    icon={capabilities?.vision ? <PaperClipOutlined /> : <FileTextOutlined />}
                    onClick={() => filePicker.current?.click()} />
          </Tooltip>

          <Tooltip title="插入程式碼區塊">
            <Button type="text" className="composer-btn" icon={<CodeOutlined />}
                    onClick={() => insertAtCaret('```\n', '\n```')} />
          </Tooltip>

          <Select
            size="small"
            value={model}
            onChange={onModelChange}
            // Shrinks rather than forcing the row to wrap: on a narrow window a
            // 190px minimum pushed the send button onto its own line.
            style={{ minWidth: 110, maxWidth: 210 }}
            popupMatchSelectWidth={240}
            variant="borderless"
            options={models.map((m) => ({
              value: m.id,
              label: (
                <Space size={6}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
                    background: m.state === 'ready' ? ACCENT.ok
                      : m.state === 'starting' ? ACCENT.warn : LINE.strong,
                  }} />
                  <span style={{ fontSize: 12 }}>{m.name || m.id}</span>
                </Space>
              ),
            }))}
          />

          {capabilities?.tools && (
            <Tooltip title={agent
              ? 'Agent 已開啟：模型可以自己寫 Python 執行、讀結果，再決定下一步'
              : '開啟 Agent：讓模型能寫 Python 執行來回答需要計算的問題'}>
              {/* Named rather than iconic. This is the one control here that
                  changes what a reply costs and how long it takes, and a bare
                  glyph makes that a guess. */}
              <Button
                type="text" className="composer-btn composer-btn-wide"
                onClick={() => onAgentChange(!agent)}
                style={{ opacity: agent ? 1 : 0.5, color: agent ? ACCENT.ok : undefined }}
              >
                <span style={{ fontSize: 11, letterSpacing: 0.3 }}>Agent</span>
              </Button>
            </Tooltip>
          )}

          <span style={{ flex: 1, minWidth: 8 }} />

          {/* Hint text is the first thing to go when space is short: it is a
              reminder, not a control. */}
          <Text className="composer-hint" style={{
            fontSize: 10.5, opacity: 0.35, fontFamily: MONO, marginInlineEnd: 4,
            whiteSpace: 'nowrap',
          }}>
            {inCode ? 'CODE ・ ENTER 換行 ・ TAB 縮排' : 'ENTER 送出 ・ SHIFT+ENTER 換行'}
          </Text>

          <Tooltip title={historyOpen ? '隱藏對話紀錄' : '顯示對話紀錄'}>
            <Button type="text" className="composer-btn" icon={<HistoryOutlined />}
                    onClick={onToggleHistory}
                    style={{ opacity: historyOpen ? 1 : 0.45 }} />
          </Tooltip>

          <Tooltip title={settingsOpen ? '隱藏參數' : '顯示參數'}>
            <Button type="text" className="composer-btn" icon={<SlidersOutlined />}
                    onClick={onToggleSettings}
                    style={{ opacity: settingsOpen ? 1 : 0.45 }} />
          </Tooltip>

          <Tooltip title="開始新對話">
            <Button type="text" className="composer-btn" icon={<ClearOutlined />}
                    disabled={!canClear} onClick={onClear} />
          </Tooltip>

          {/* One square that changes job rather than two buttons that swap
              places: the row keeps its geometry the moment a reply starts. */}
          {streaming ? (
            <Tooltip title="停止產生">
              <Button danger type="primary" className="composer-send"
                      icon={<StopOutlined />} onClick={onStop} />
            </Tooltip>
          ) : (
            <Tooltip title={canSend ? '送出 (Enter)' : '先輸入訊息'}>
              <Button type="primary" className="composer-send"
                      icon={<SendOutlined />} onClick={onSend} disabled={!canSend} />
            </Tooltip>
          )}
        </div>
      </div>

      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
