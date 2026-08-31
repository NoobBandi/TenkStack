import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Segmented, Space, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import ini from 'highlight.js/lib/languages/ini';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import powershell from 'highlight.js/lib/languages/powershell';
import { fetchModels, type Endpoint, type ModelInfo } from '../api';
import { LINE, MONO } from '../theme';

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
 * One snippet, coloured by highlight.js and painted by the palette in
 * index.css -- the same one the markdown renderer uses, so a config here and a
 * fenced block in a reply look like the same kind of thing.
 *
 * dangerouslySetInnerHTML is safe here because highlight.js escapes what it is
 * given before wrapping it in spans; a model id containing markup comes back as
 * entities. Checked rather than assumed.
 */
function Code({ body, lang }: { body: string; lang: string }) {
  const html = hljs.highlight(body, { language: lang, ignoreIllegals: true }).value;
  return (
    <pre style={BOX}>
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

const BOX: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 6,
  overflowX: 'auto', margin: 0, fontSize: 12, lineHeight: 1.55, fontFamily: MONO,
};

/**
 * Ready-made client configuration.
 *
 * Filled in from the machine's own state -- the address the console was opened
 * on, and the first configured model -- because the failure people actually hit
 * is pasting an example and then having to work out which host and which model
 * id belong in it.
 *
 * Every box is a whole file, valid as it stands. It used to carry explanation
 * inside it, which meant the JSON one could not be pasted into a JSON file and
 * the reader had to edit before saving -- exactly the step this card exists to
 * remove. Prose is above the box now, and the box is only ever the artefact.
 *
 * The compaction settings are here for the same reason the slot meter is on the
 * dashboard. A client that walks into the end of the window gets its reply cut
 * in half, and a reply cut inside a tool call leaves malformed JSON the client
 * replays on every turn afterwards -- the session is dead and only a new one
 * fixes it. Every agent here can be told to summarise before that happens; none
 * of them did, because the setting was not written down anywhere.
 */

function urlFor(endpoint: Endpoint, host: string): string {
  const path = endpoint.path === '/' ? '' : endpoint.path;
  return `${endpoint.scheme}://${host}:${endpoint.port}${path}`;
}

interface Block {
  /** The file this is, or what it is for. Shown above the box. */
  title: string;
  body: string;
  /** A highlight.js language id, from the five registered above. */
  lang: string;
  note?: string;
}

interface Snippet {
  key: string;
  label: string;
  group: 'agent' | 'raw';
  caption: string;
  blocks: Block[];
  shellCaption?: string;
  shell?: { linux: string; windows: string };
}

/**
 * Which host these are written for is decided above, not here.
 *
 * This card had a host selector of its own, beside the one on the endpoint
 * list, and the two did not agree. Copying an address from one and a config
 * from the other produced a snippet pointing at a machine name the reader had
 * not chosen -- so the choice moved to the page and this takes it as a prop.
 */
interface Props {
  endpoints: Endpoint[];
  hostname: string;
  tab: string;
  onTab: (key: string) => void;
}

export default function ClientSnippets({ endpoints, hostname, tab, onTab }: Props) {
  const { message } = AntApp.useApp();
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Which shell the command box is written for. `export` and `$env:` are
  // different languages, and on Windows the second one lasts only as long as
  // the window.
  const [shell, setShell] = useState<'linux' | 'windows'>('linux');

  useEffect(() => { fetchModels().then(setModels).catch(() => undefined); }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已複製');
    } catch {
      message.warning('瀏覽器不允許複製，請手動選取');
    }
  }, [message]);

  const apiBase = endpoints.find((e) => e.key === 'api-http')
    ?? endpoints.find((e) => e.key === 'api-https');
  const base = apiBase ? urlFor(apiBase, hostname) : 'http://<host>:8000/v1';
  // Claude Code appends `/v1/messages` itself, so it needs the origin rather
  // than the base every other client here wants. Taking it off the same
  // endpoint keeps the two from drifting when the port or host changes.
  const origin = apiBase
    ? `${apiBase.scheme}://${hostname}:${apiBase.port}`
    : 'http://<host>:8000';
  const model = models[0];
  const modelId = model?.id ?? '<model-id>';
  const modelName = model?.name || modelId;
  const vision = model?.capabilities?.vision ?? false;
  // Per slot, not the configured --ctx-size: a request fills one slot, and that
  // slot's share is the wall it actually runs into.
  const ctx = model?.slots?.[0]?.n_ctx ?? model?.ctx_size ?? 32768;

  // Derived rather than fixed, so the numbers stay right when the window does.
  //
  // A reply capped well below the window is the single setting that would have
  // prevented the dead session: a generation that runs out of room is truncated
  // mid-token, while one that hits its own ceiling stops cleanly and can be
  // continued.
  const output = Math.min(16384, Math.floor(ctx / 4));
  // Summarise at three quarters. Leaves a whole quarter for the summarising
  // request itself plus the reply after it, which is what makes the compaction
  // land before the wall rather than against it.
  const compactAt = Math.floor(ctx * 0.75);
  const reserved = Math.floor(ctx / 8);
  const keepRecent = Math.floor(ctx / 6);

  const snippets: Snippet[] = [
    {
      key: 'opencode',
      label: 'Opencode',
      group: 'agent',
      caption: `設定檔放 ~/.config/opencode/opencode.json（Windows 是 %USERPROFILE%\\.config\\opencode\\opencode.json）。`
             + `金鑰用 {env:TENKS_KEY} 從環境變數讀，不寫進檔案。`
             + `compaction 的欄位名以 $schema 指向的實際 schema 為準——文件上寫的 keep.tokens／buffer 是另一版，填了不會生效。`,
      blocks: [
        {
          title: '~/.config/opencode/opencode.json',
          lang: 'json',
          body: JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            provider: {
              tenks: {
                npm: '@ai-sdk/openai-compatible',
                name: 'TenkStack',
                options: { baseURL: base, apiKey: '{env:TENKS_KEY}' },
                models: {
                  [modelId]: {
                    name: modelName,
                    ...(vision ? {
                      attachment: true,
                      modalities: { input: ['text', 'image'], output: ['text'] },
                    } : {}),
                    limit: { context: ctx, output },
                  },
                },
              },
            },
            model: `tenks/${modelId}`,
            small_model: `tenks/${modelId}`,
            compaction: {
              auto: true,
              prune: true,
              reserved,
              preserve_recent_tokens: keepRecent,
            },
          }, null, 2),
          note: `limit.context 必須等於這台機器每個 slot 的實際視窗（目前 ${ctx.toLocaleString()}）。`
              + `寫大了會撞牆被截斷，寫小了白白浪費。`
              + `prune 會丟掉舊的工具輸出，對反覆讀同一批檔案的工作省很多；預設是關的。`
              + `small_model 不設會去要一個這台沒有的名字。`,
        },
      ],
      shellCaption: '金鑰放環境變數。PowerShell 的 $env: 只在這個視窗有效，要留著改用 setx（新開的視窗才生效）。',
      shell: {
        linux: `export TENKS_KEY="sk-console-..."\nopencode`,
        windows: `$env:TENKS_KEY = "sk-console-..."\nopencode`,
      },
    },
    {
      key: 'claude-code',
      label: 'Claude Code',
      group: 'agent',
      caption: 'Linux／macOS 放 ~/.claude/settings.json，Windows 放 %USERPROFILE%\\.claude\\settings.json。'
             + 'ANTHROPIC_BASE_URL 不要帶 /v1，Claude Code 自己會接上 /v1/messages。'
             + 'env 裡的值一律是字串，數字也要加引號。',
      blocks: [
        {
          title: '~/.claude/settings.json',
          lang: 'json',
          body: JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: origin,
              ANTHROPIC_AUTH_TOKEN: 'sk-console-...',
              ANTHROPIC_MODEL: modelId,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
              CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '75',
              CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(output),
            },
          }, null, 2),
          note: '背景小工作會另外叫一個「快速模型」，不指定就會送 claude-haiku-*，這台沒有那個名字，所以兩個都要設。'
              + 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 是幾成滿才開始壓縮（0–100）；'
              + '要完全關掉自動壓縮是 DISABLE_AUTO_COMPACT=1，但那樣就得自己記得下 /compact。',
        },
      ],
      shellCaption: '不想改設定檔就用環境變數跑一次。',
      shell: {
        linux: `export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="sk-console-..."
export ANTHROPIC_MODEL="${modelId}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${modelId}"
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="75"
claude`,
        windows: `$env:ANTHROPIC_BASE_URL = "${origin}"
$env:ANTHROPIC_AUTH_TOKEN = "sk-console-..."
$env:ANTHROPIC_MODEL = "${modelId}"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "${modelId}"
$env:CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "75"
claude`,
      },
    },
    {
      key: 'codex',
      label: 'Codex',
      group: 'agent',
      caption: 'Linux／macOS 放 ~/.codex/config.toml，Windows 放 %USERPROFILE%\\.codex\\config.toml。'
             + 'Codex 只講 OpenAI 協定，而且從 2026 年 2 月起只剩 Responses API（wire_api = "chat" 已移除）；'
             + 'llama-server 有 /v1/responses 所以能用。內建的 provider id（openai／ollama／lmstudio）不能覆寫，要取自己的名字。',
      blocks: [
        {
          title: '~/.codex/config.toml',
          lang: 'ini',
          body: `model_provider = "tenks"
model = "${modelId}"

model_context_window = ${ctx}
model_max_output_tokens = ${output}
model_auto_compact_token_limit = ${compactAt}

[model_providers.tenks]
name = "TenkStack"
base_url = "${base}"
env_key = "TENKS_KEY"
wire_api = "responses"`,
          note: `這三個數字是重點。Codex 預設會照它自己猜的視窗跑，猜錯就一路寫到撞牆，`
              + `回覆從工具呼叫中間被切斷之後那個 session 就永久壞掉——每次重送都是同一段殘缺 JSON，伺服器一律回 500。`
              + `model_auto_compact_token_limit 讓它在 ${compactAt.toLocaleString()} 就先摘要。`
              + `另外 model_context_window 在 Codex 0.116–0.117 有過會弄壞自動壓縮的問題，那兩版請不要設。`,
        },
      ],
      shellCaption: '金鑰不寫在設定檔裡，Codex 只記變數名稱，值從環境變數讀。',
      shell: {
        linux: `export TENKS_KEY="sk-console-..."\ncodex`,
        windows: `$env:TENKS_KEY = "sk-console-..."\ncodex`,
      },
    },
    {
      key: 'grok',
      label: 'Grok Build',
      group: 'agent',
      caption: '設定檔放 ~/.grok/config.toml（Windows 是 %USERPROFILE%\\.grok\\config.toml，'
             + '或用 $GROK_HOME 指定）。api_backend 選 chat_completions，llama-server 這條路最穩。',
      blocks: [
        {
          title: '~/.grok/config.toml',
          lang: 'ini',
          body: `[model.tenks-${modelId}]
model = "${modelId}"
base_url = "${base}"
name = "${modelName}（本機）"
env_key = "TENKS_KEY"
api_backend = "chat_completions"
context_window = ${ctx}
max_completion_tokens = ${output}

[models]
default = "tenks-${modelId}"

[session]
auto_compact_threshold_percent = 75`,
          note: `context_window 是 Grok 決定何時自動壓縮的依據，不填它會照自己猜的跑。`
              + `auto_compact_threshold_percent 預設 85，這裡壓到 75 是因為這台的回覆長、`
              + `85% 才開始摘要容易在摘要途中就把剩下的空間用完。`
              + `驗證有沒有讀到用 grok inspect；指定執行 grok -p "你好" -m tenks-${modelId}；`
              + `互動模式內用 /model tenks-${modelId} 切換。`,
        },
      ],
      shellCaption: '金鑰放環境變數。',
      shell: {
        linux: `export TENKS_KEY="sk-console-..."\ngrok`,
        windows: `$env:TENKS_KEY = "sk-console-..."\ngrok`,
      },
    },
    {
      key: 'curl',
      label: 'curl',
      group: 'raw',
      caption: '先在 shell 設好 TENKS_KEY。chat_template_kwargs 關掉思考模式——留著的話回覆會先產一段 <think>。',
      blocks: [
        {
          title: 'Chat Completions',
          lang: 'bash',
          body: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $TENKS_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": ${output},
    "chat_template_kwargs": {"enable_thinking": false}
  }'`,
        },
      ],
    },
    {
      key: 'python',
      label: 'Python',
      group: 'raw',
      caption: '用官方 openai 套件，指向這台的 base_url 就好。',
      blocks: [
        {
          title: 'openai',
          lang: 'python',
          body: `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="sk-console-...")

resp = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=${output},
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)
print(resp.choices[0].message.content)`,
        },
      ],
    },
  ];

  const active = snippets.find((s) => s.key === tab) ?? snippets[0];
  const groups: { key: Snippet['group']; label: string }[] = [
    { key: 'agent', label: '編碼代理' },
    { key: 'raw', label: '直接呼叫' },
  ];

  return (
    <Card title="用戶端設定範例" size="small">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* Two rows rather than one list: an agent needs a config file and a
            compaction policy, a raw call needs neither, and putting them in one
            strip made curl look like something you configure. Only the row
            holding the selection shows one -- Segmented renders nothing as
            chosen when its value is not among its options. */}
        {groups.map((g) => (
          <Space key={g.key} size={10} wrap>
            <Text style={{ fontSize: 11, opacity: 0.4, width: 52, display: 'inline-block' }}>
              {g.label}
            </Text>
            <Segmented
              size="small"
              value={active.group === g.key ? tab : ''}
              onChange={(v) => onTab(v as string)}
              options={snippets.filter((s) => s.group === g.key)
                .map((s) => ({ label: s.label, value: s.key }))}
            />
          </Space>
        ))}

        <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
          {active.caption}
          {' '}位址與模型 id 取自這台機器目前的狀態。API key 到「使用者」頁建立，只會顯示一次。
        </Paragraph>

        {active.blocks.map((block) => (
          <div key={block.title}>
            <Space size={8} style={{ marginBottom: 5 }}>
              <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.55 }}>
                {block.title}
              </Text>
              <Button type="text" size="small" icon={<CopyOutlined />}
                      onClick={() => copy(block.body)}>
                複製
              </Button>
            </Space>
            <Code body={block.body} lang={block.lang} />
            {block.note && (
              <Paragraph type="secondary" style={{
                fontSize: 11.5, margin: '6px 0 0', opacity: 0.75,
                paddingLeft: 9, borderLeft: `1px solid ${LINE.faint}`,
              }}>
                {block.note}
              </Paragraph>
            )}
          </div>
        ))}

        {/* The command box exists because the boxes above are files and this is
            something you type. Keeping them apart is the difference between a
            config to paste and a command to run -- and the command is not the
            same command on both platforms. */}
        {active.shell && (
          <div>
            <Space size={10} wrap style={{ marginBottom: 5 }}>
              <Segmented
                size="small"
                value={shell}
                onChange={(v) => setShell(v as 'linux' | 'windows')}
                options={[
                  { label: 'Linux／macOS', value: 'linux' },
                  { label: 'Windows PowerShell', value: 'windows' },
                ]}
              />
              <Button type="text" size="small" icon={<CopyOutlined />}
                      onClick={() => copy(active.shell![shell])}>
                複製
              </Button>
            </Space>
            {active.shellCaption && (
              <Paragraph type="secondary" style={{ fontSize: 12, margin: '0 0 5px' }}>
                {active.shellCaption}
              </Paragraph>
            )}
            <Code body={active.shell[shell]} lang={shell === 'windows' ? 'powershell' : 'bash'} />
          </div>
        )}
      </Space>
    </Card>
  );
}
