import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Image, Space, Tag, Tooltip, Typography } from 'antd';
import {
  CloseOutlined, CodeOutlined, FileTextOutlined, PictureOutlined,
  SendOutlined, StopOutlined,
} from '@ant-design/icons';
import type { ModelCapabilities } from '../api';

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
 */

const FONT = "ui-monospace, SFMono-Regular, Menlo, 'Noto Sans Mono CJK TC', monospace";

/** Typography must be identical in both layers or the shading drifts. */
const SHARED: React.CSSProperties = {
  margin: 0,
  padding: 12,
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

/** Split on fence lines, tracking whether each run is inside a block. */
function segment(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let inside = false;
  let buffer: string[] = [];

  const flush = (code: boolean) => {
    if (buffer.length) {
      segments.push({ text: buffer.join('\n'), code });
      buffer = [];
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      // The fence line itself belongs to the block, opening or closing.
      flush(inside);
      segments.push({ text: line, code: true });
      inside = !inside;
    } else {
      buffer.push(line);
    }
  }
  flush(inside);

  // Rebuild the newlines that split() removed, so the backdrop's text is
  // character-for-character what the textarea holds.
  return segments.reduce<Segment[]>((acc, seg, index) => {
    acc.push(index === 0 ? seg : { ...seg, text: `\n${seg.text}` });
    return acc;
  }, []);
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
}

export default function Composer({
  value, onChange, onSend, onStop, streaming, disabled,
  capabilities, images, onImagesChange,
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

  return (
    <div>
      <div style={{
        position: 'relative',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        overflow: 'hidden',
      }}>
        <div
          ref={backdrop}
          aria-hidden
          style={{
            ...SHARED,
            position: 'absolute', inset: 0, overflow: 'hidden',
            color: 'transparent', pointerEvents: 'none',
          }}
        >
          {segments.map((seg, index) =>
            seg.code ? (
              <span key={index} style={{
                background: 'rgba(128,128,128,0.20)',
                borderRadius: 3,
                fontFamily: FONT,
              }}>
                {seg.text}
              </span>
            ) : (
              <span key={index}>{seg.text}</span>
            ),
          )}
          {/* Trailing newline needs a character or the last empty line collapses. */}
          {'​'}
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
            minHeight: 96,
            resize: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'inherit',
            display: 'block',
          }}
        />
      </div>

      {images.length > 0 && (
        <Space wrap size={8} style={{ marginTop: 8 }}>
          {images.map((src, index) => (
            <div key={index} style={{ position: 'relative' }}>
              <Image src={src} width={64} height={64}
                     style={{ objectFit: 'cover', borderRadius: 6 }} />
              <Button
                size="small" type="primary" danger shape="circle" icon={<CloseOutlined />}
                style={{ position: 'absolute', top: -6, right: -6, minWidth: 18, width: 18, height: 18 }}
                onClick={() => onImagesChange(images.filter((_, i) => i !== index))}
              />
            </div>
          ))}
        </Space>
      )}

      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        onChange={(e) => { if (e.target.files) void attach(e.target.files); e.target.value = ''; }}
      />

      <Space style={{ width: '100%', justifyContent: 'space-between', marginTop: 8 }}>
        <Space size={8} wrap>
          <Tooltip title="插入程式碼區塊">
            <Button size="small" icon={<CodeOutlined />}
                    onClick={() => insertAtCaret('```\n', '\n```')}>
              程式碼
            </Button>
          </Tooltip>
          <Tooltip title="文字與程式碼檔會直接插入訊息，任何模型都讀得到">
            <Button size="small" icon={<FileTextOutlined />}
                    onClick={() => filePicker.current?.click()}>
              附加檔案
            </Button>
          </Tooltip>
          <Tooltip
            title={capabilities?.vision
              ? '可附加圖片，也可以直接貼上'
              : '這個模型沒有載入視覺投影檔（mmproj），無法讀圖'}
          >
            <Tag
              icon={<PictureOutlined />}
              color={capabilities?.vision ? 'green' : 'default'}
              style={{ marginInlineEnd: 0, opacity: capabilities?.vision ? 1 : 0.55 }}
            >
              {capabilities?.vision ? '支援圖片' : '不支援圖片'}
            </Tag>
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {inCode ? '程式碼區塊內 ・ Enter 換行、Tab 縮排' : 'Enter 送出 ・ Shift+Enter 換行'}
          </Text>
        </Space>

        {streaming ? (
          <Button danger icon={<StopOutlined />} onClick={onStop}>停止</Button>
        ) : (
          <Button type="primary" icon={<SendOutlined />} onClick={onSend}
                  disabled={!value.trim() || disabled}>
            送出
          </Button>
        )}
      </Space>
    </div>
  );
}
