import { useCallback, useState } from 'react';
import { App as AntApp, Button, Space, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CopyOutlined, InfoCircleOutlined, KeyOutlined } from '@ant-design/icons';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import ini from 'highlight.js/lib/languages/ini';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import powershell from 'highlight.js/lib/languages/powershell';
import { ACCENT, LINE } from '../theme';
import CodeSurface from './CodeSurface';
import { KEY_PLACEHOLDER, type Snippet } from './snippet-types';

const { Paragraph, Text } = Typography;

// Registered by hand rather than pulling the full bundle: five languages
// against highlight.js's two hundred is the difference between a few kilobytes
// and half a megabyte in a page that shows one snippet at a time. TOML is read
// by the ini grammar, which is what highlight.js itself maps it to.
hljs.registerLanguage('json', json);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);

/**
 * One snippet, in the same frame a fenced block in a reply gets.
 *
 * Coloured by highlight.js and painted by the palette in index.css -- the same
 * one the markdown renderer uses -- and now drawn by the same component too, so
 * a config to paste and a block a model wrote are visibly one kind of object.
 *
 * dangerouslySetInnerHTML is safe here because highlight.js escapes what it is
 * given before wrapping it in spans; a model id containing markup comes back as
 * entities. Checked rather than assumed.
 */
function Code({ body, lang, name, onCopy }: {
  body: string;
  lang: string;
  name: string;
  onCopy: () => void;
}) {
  const html = hljs.highlight(body, { language: lang, ignoreIllegals: true }).value;
  const lines = body.split('\n');
  return (
    <CodeSurface
      name={name}
      actions={(
        <Tooltip title="複製">
          <Button type="text" size="small" icon={<CopyOutlined />} onClick={onCopy} />
        </Tooltip>
      )}
      // A one-line command needs no gutter; numbering it says "1".
      gutter={lines.length > 1 && lines.map((_, i) => <span key={i}>{i + 1}</span>)}
    >
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </CodeSurface>
  );
}

/**
 * Ready-made client configuration.
 *
 * Filled in from the machine's own state -- the address the console was opened
 * on, and the first configured model -- because the failure people actually hit
 * is pasting an example and then having to work out which host and which model
 * id belong in it.
 *
 * The page lists the tools; the one chosen shows its steps here, in the order
 * the work is done: which machine you are on, the command that opens the
 * tool's config file, what to put in it, and how that tool wants its key. The
 * order is the point -- the config used to come first and the file it belongs
 * in was a sentence above it, so the first thing anyone did was go and find
 * out where that file was. Why each value is what it is folds away under the
 * step, for whoever wants it.
 *
 * Every box is a whole artefact, valid as it stands: a command to run or a file
 * to paste, never one carrying explanation inside it. Prose sits above the box.
 *
 * No `export` anywhere. Each tool has its own way to be given a key -- a login
 * command, a helper, a file read on demand, a literal in its own config -- and
 * an `export` in front of the binary is none of them: it survives one shell and
 * teaches nobody where the key actually belongs.
 *
 * The compaction settings are here for the same reason the slot meter is on the
 * dashboard. A client that walks into the end of the window gets its reply cut
 * in half, and a reply cut inside a tool call leaves malformed JSON the client
 * replays on every turn afterwards -- the session is dead and only a new one
 * fixes it. Every agent here can be told to summarise before that happens; none
 * of them did, because the setting was not written down anywhere.
 */

/** What a box holds, for its header: the step's name is beside it already. */
const LANG_NAME: Record<string, string> = {
  bash: '終端機', powershell: 'PowerShell', json: 'JSON', ini: 'TOML', python: 'Python',
};

/** A framed line of note, the one thing to know before starting. */
function Notice({ tone, children, action }: {
  tone: 'info' | 'warn' | 'ok'; children: React.ReactNode; action?: React.ReactNode;
}) {
  const colour = tone === 'warn' ? ACCENT.warn : tone === 'ok' ? ACCENT.ok : 'rgba(255,255,255,0.45)';
  const Icon = tone === 'warn' ? KeyOutlined : tone === 'ok' ? CheckCircleFilled : InfoCircleOutlined;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px',
      border: `1px solid ${LINE.faint}`, borderRadius: 6, background: 'rgba(255,255,255,0.02)',
    }}>
      <Icon style={{ color: colour, fontSize: 14, flex: 'none' }} />
      <Text style={{ fontSize: 12, lineHeight: 1.7, flex: '1 1 240px', minWidth: 0 }}>{children}</Text>
      {action}
    </div>
  );
}

/**
 * One tool's steps, as a numbered line down the card: what to know first,
 * whether the key is filled in, then each step's name with its box under it,
 * and why it is written that way folded beside the name for whoever wants it.
 */
export function ToolSteps({ snippet, apiKey, onCreateKey }: {
  snippet: Snippet; apiKey: string | null; onCreateKey?: () => void;
}) {
  const { message } = AntApp.useApp();
  const [why, setWhy] = useState<string[]>([]);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已複製');
    } catch {
      message.warning('瀏覽器不允許複製，請手動選取');
    }
  }, [message]);

  const last = snippet.steps.length - 1;
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Notice tone="info">{snippet.caption}</Notice>
      {apiKey ? (
        <Notice tone="ok">已帶入剛建立的金鑰，照著貼就能用。</Notice>
      ) : (
        <Notice
          tone="warn"
          action={onCreateKey && <Button size="small" onClick={onCreateKey}>建立金鑰</Button>}
        >
          步驟裡的 <Text code style={{ fontSize: 12 }}>{KEY_PLACEHOLDER}</Text> 要換成你的金鑰；在這裡建立的話會自動帶入。
        </Notice>
      )}

      <div style={{ marginTop: 6 }}>
        {snippet.steps.map((step, i) => {
          const id = `${snippet.key}-${step.title}`;
          const open = why.includes(id);
          return (
            <div key={id} style={{ display: 'flex', gap: 12 }}>
              {/* The number, and the line down to the next one. */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 'none' }}>
                <span style={{
                  width: 24, height: 24, borderRadius: '50%', border: `1px solid ${LINE.medium}`,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 600,
                }}>
                  {i + 1}
                </span>
                {i < last && <span style={{ flex: 1, width: 1, background: LINE.soft, margin: '4px 0' }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0, paddingBottom: i < last ? 20 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, marginBottom: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{step.title}</span>
                  {step.note && (
                    <Button type="link" size="small"
                            style={{ padding: 0, fontSize: 12, height: 'auto', marginInlineStart: 'auto', opacity: 0.7 }}
                            onClick={() => setWhy((w) => (open ? w.filter((x) => x !== id) : [...w, id]))}>
                      {open ? '收起說明' : '為什麼這樣設？'}
                    </Button>
                  )}
                </div>
                {open && step.note && (
                  <Paragraph type="secondary" style={{
                    fontSize: 12, margin: '0 0 10px', lineHeight: 1.7,
                    paddingLeft: 9, borderLeft: `1px solid ${LINE.faint}`,
                  }}>
                    {step.note}
                  </Paragraph>
                )}
                <Code body={step.body} lang={step.lang} name={LANG_NAME[step.lang] ?? step.lang}
                      onCopy={() => copy(step.body)} />
              </div>
            </div>
          );
        })}
      </div>
    </Space>
  );
}
