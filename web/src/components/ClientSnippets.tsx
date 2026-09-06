import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Segmented, Space, Tooltip, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import ini from 'highlight.js/lib/languages/ini';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import powershell from 'highlight.js/lib/languages/powershell';
import { fetchLastUsedModel, fetchModels, type Endpoint, type ModelInfo } from '../api';
import { LINE } from '../theme';
import CodeSurface from './CodeSurface';
import {
  detectOs, openCommand, shellLang, writeKeyCommand,
  KEY_FILE, KEY_FILE_ABS, type Os, type Snippet,
} from './snippet-types';

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
 * Read as a sequence, in the order the work is done: which machine you are on,
 * which tool, the command that opens that tool's config file, what to put in
 * it, and how that tool wants its key. The order is the point -- the config
 * used to come first and the file it belongs in was a sentence above it, so the
 * first thing anyone did was go and find out where that file was.
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

function urlFor(endpoint: Endpoint, host: string): string {
  const path = endpoint.path === '/' ? '' : endpoint.path;
  return `${endpoint.scheme}://${host}:${endpoint.port}${path}`;
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
  const [os, setOs] = useState<Os>(detectOs);

  // The id of the last request in llama-swap's history, for when nothing is
  // loaded. Fetched alongside the list because it is only ever needed as that
  // list's fallback.
  const [lastUsed, setLastUsed] = useState<string | null>(null);

  useEffect(() => {
    fetchModels().then(setModels).catch(() => undefined);
    fetchLastUsedModel().then(setLastUsed).catch(() => undefined);
  }, []);

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
  // What these configs should name: whatever is loaded, because that is what a
  // request sent right now would reach. Falling back to the last model used
  // rather than to models[0] -- the first entry is an artefact of config order,
  // and on a box that has been used it is rarely the one anybody wants.
  const model = models.find((m) => m.running)
    ?? models.find((m) => m.id === lastUsed)
    ?? models[0];
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
  // Summarise at 85%. The remaining seventh holds the summarising request itself
  // plus the reply after it, which is what makes the compaction land before the
  // wall rather than against it.
  //
  // One number for every client on this page. Each of them spells the same idea
  // differently -- Codex names the threshold, Claude Code and Pi name the
  // headroom left above it -- so they are all derived from this rather than
  // written out separately, and a reader comparing two tabs sees one policy.
  const compactAt = Math.floor(ctx * 0.85);
  const reserved = ctx - compactAt;
  const keepRecent = Math.floor(ctx / 6);

  const win = os === 'windows';
  const keyPath = win ? KEY_FILE.win : KEY_FILE.unix;
  const keyAbs = os === 'mac' ? KEY_FILE_ABS.mac : KEY_FILE_ABS.unix;
  const sh = shellLang(os);

  const snippets: Snippet[] = [
    {
      key: 'opencode',
      label: 'Opencode',
      group: 'agent',
      caption: 'compaction 的欄位名以 $schema 指向的實際 schema 為準——文件上寫的 keep.tokens／buffer 是另一版，填了不會生效。',
      steps: [
        {
          title: '③ 開啟設定檔',
          lang: sh,
          body: openCommand(os, '~/.config/opencode/opencode.json',
            '$env:USERPROFILE\\.config\\opencode\\opencode.json'),
        },
        {
          title: '④ 貼進去：模型參數',
          lang: 'json',
          body: JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            provider: {
              tenks: {
                npm: '@ai-sdk/openai-compatible',
                name: 'TenkStack',
                options: { baseURL: base },
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
        {
          title: '⑤ 金鑰：在 opencode 裡打',
          lang: 'bash',
          body: '/connect',
          note: '不是 shell 指令，是進 opencode 之後在對話框裡打的。'
              + '選到上面設定的 tenks，貼上金鑰就好。'
              + '存在 ~/.local/share/opencode/auth.json，權限 0600，設定檔裡不會有金鑰。',
        },
      ],
    },
    {
      key: 'claude-code',
      label: 'Claude Code',
      group: 'agent',
      caption: 'ANTHROPIC_BASE_URL 不要帶 /v1，Claude Code 自己會接上 /v1/messages。env 裡的值一律是字串，數字也要加引號。',
      steps: [
        {
          title: '③ 開啟設定檔',
          lang: sh,
          body: openCommand(os, '~/.claude/settings.json',
            '$env:USERPROFILE\\.claude\\settings.json'),
        },
        {
          title: '④ 貼進去：模型參數',
          lang: 'json',
          body: JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: origin,
              ANTHROPIC_MODEL: modelId,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
              CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '75',
              CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(output),
            },
            apiKeyHelper: win
              ? `powershell -NoProfile -Command "Get-Content -Raw '${KEY_FILE.win}'"`
              : `cat ${KEY_FILE.unix}`,
          }, null, 2),
          note: '背景小工作會另外叫一個「快速模型」，不指定就會送 claude-haiku-*，這台沒有那個名字，所以兩個都要設。'
              + 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 是幾成滿才開始壓縮（0–100）；'
              + '要完全關掉自動壓縮是 DISABLE_AUTO_COMPACT=1，但那樣就得自己記得下 /compact。'
              + 'apiKeyHelper 是 Claude Code 取金鑰的方式：每次送請求前執行那行指令，把 stdout 當金鑰，'
              + `所以金鑰不在這個檔案裡，而在 ${keyPath}。`
              + '也可以改成在 env 裡加 ANTHROPIC_AUTH_TOKEN 直接寫死，那樣就不需要金鑰檔。',
        },
        {
          title: '⑤ 建立金鑰檔',
          lang: sh,
          body: writeKeyCommand(os),
        },
      ],
    },
    {
      key: 'codex',
      label: 'Codex',
      group: 'agent',
      caption: 'Codex 只講 OpenAI 協定，而且從 2026 年 2 月起只剩 Responses API（wire_api = "chat" 已移除）；'
             + 'llama-server 有 /v1/responses 所以能用。內建的 provider id（openai／ollama／lmstudio）不能覆寫，要取自己的名字。',
      steps: [
        {
          title: '③ 開啟設定檔',
          lang: sh,
          body: openCommand(os, '~/.codex/config.toml',
            '$env:USERPROFILE\\.codex\\config.toml'),
        },
        {
          title: '④ 貼進去：模型參數',
          lang: 'ini',
          body: `model_provider = "tenks"
model = "${modelId}"

model_context_window = ${ctx}
model_max_output_tokens = ${output}
model_auto_compact_token_limit = ${compactAt}

[model_providers.tenks]
name = "TenkStack"
base_url = "${base}"
wire_api = "responses"

[model_providers.tenks.auth]
${win
  ? `command = "cmd"
args = ["/c", "type", "%USERPROFILE%\\\\.tenks-key"]`
  : `command = "cat"
args = ["${keyAbs}"]`}
refresh_interval_ms = 86400000`,
          note: `這三個數字是重點。Codex 預設會照它自己猜的視窗跑，猜錯就一路寫到撞牆，`
              + `回覆從工具呼叫中間被切斷之後那個 session 就永久壞掉——每次重送都是同一段殘缺 JSON，伺服器一律回 500。`
              + `model_auto_compact_token_limit 讓它在 ${compactAt.toLocaleString()} 就先摘要。`
              + `另外 model_context_window 在 Codex 0.116–0.117 有過會弄壞自動壓縮的問題，那兩版請不要設。`
              + `最後那段 auth 是金鑰：Codex 會執行那行指令，把 stdout 當成 bearer token——`
              + `本來是給 Vault、AWS SSO 那種短期憑證用的，讀一個檔案同樣成立。`
              + `它不能和 env_key 併用，兩個都寫會被拒絕。args 要寫絕對路徑，TOML 不會展開 ~。`
              + `refresh_interval_ms 預設 5 分鐘，靜態金鑰設長一點免得一直重跑。`,
        },
        {
          title: '⑤ 建立金鑰檔',
          lang: sh,
          body: writeKeyCommand(os),
        },
      ],
    },
    {
      key: 'grok',
      label: 'Grok Build',
      group: 'agent',
      caption: 'api_backend 選 chat_completions，llama-server 這條路最穩。',
      steps: [
        {
          title: '③ 開啟設定檔',
          lang: sh,
          body: openCommand(os, '~/.grok/config.toml',
            '$env:USERPROFILE\\.grok\\config.toml'),
        },
        {
          title: '④ 貼進去：模型參數',
          lang: 'ini',
          body: `[model.tenks-${modelId}]
model = "${modelId}"
base_url = "${base}"
name = "${modelName}（本機）"
api_key = "sk-console-..."
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
              + `互動模式內用 /model tenks-${modelId} 切換。`
              + `api_key 直接寫在裡面是 Grok Build 支援的兩種之一，另一種是 env_key 讀環境變數，`
              + `官方文件偏好後者。既然金鑰躺在檔案裡，這個檔案請 chmod 600。`,
        },
      ],
    },
    {
      key: 'pi',
      label: 'Pi Agent',
      group: 'agent',
      caption: 'Pi 的自訂 provider 走 ~/.pi/agent/models.json；'
             + '另一條 pi.registerProvider() 是寫 extension 用的，接一台自架伺服器不需要走到那裡。'
             + '這個檔案每次打開 /model 都會重讀，改完不用重開。',
      steps: [
        {
          title: '③ 開啟模型設定檔',
          lang: sh,
          body: openCommand(os, '~/.pi/agent/models.json',
            '$env:USERPROFILE\\.pi\\agent\\models.json'),
        },
        {
          title: '④ 貼進去：模型參數',
          lang: 'json',
          body: JSON.stringify({
            providers: {
              tenks: {
                baseUrl: base,
                api: 'openai-completions',
                apiKey: 'sk-console-...',
                authHeader: true,
                compat: {
                  supportsDeveloperRole: false,
                  supportsReasoningEffort: false,
                },
                models: [
                  {
                    id: modelId,
                    name: modelName,
                    reasoning: true,
                    input: vision ? ['text', 'image'] : ['text'],
                    contextWindow: ctx,
                    maxTokens: output,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          }, null, 2),
          note: 'reasoning 開著、compat 兩個關著不衝突：前者說這個模型會思考，'
              + '後者說別用 OpenAI 那套參數去要求它。'
              + 'compat 那兩個是重點：Pi 對支援推理的模型會送 developer 角色和 reasoning_effort，'
              + '而 llama-server 這類 OpenAI 相容伺服器不認得，官方文件點名 Ollama／vLLM／SGLang 都要關。'
              + `contextWindow 填每個 slot 的實際視窗（目前 ${ctx.toLocaleString()}），`
              + 'cost 全填 0，本機沒有計費但欄位要在。'
              + '確認有沒有讀到用 pi --list-models。'
              + 'apiKey 這裡直接寫字面值；它也吃 "$環境變數" 和 "!指令"（取 stdout），'
              + `例如 "!cat ${keyPath}" 或 macOS 的 "!security find-generic-password -ws tenks"，`
              + '那樣金鑰就不在這個檔案裡。也可以在 pi 裡下 /login 存起來。',
        },
        {
          title: '⑤ 開啟 agent 設定檔',
          lang: sh,
          body: openCommand(os, '~/.pi/agent/settings.json',
            '$env:USERPROFILE\\.pi\\agent\\settings.json'),
        },
        {
          title: '⑥ 貼進去：什麼時候壓縮上下文',
          lang: 'json',
          body: JSON.stringify({
            compaction: {
              enabled: true,
              reserveTokens: reserved,
              keepRecentTokens: keepRecent,
            },
          }, null, 2),
          note: '壓縮設定不在 models.json —— 那個檔案描述模型是什麼，這個檔案描述 agent 怎麼行為。'
              + 'Pi 的判斷式是 contextTokens > contextWindow − reserveTokens，'
              + `所以填 ${reserved.toLocaleString()} 就是在 ${compactAt.toLocaleString()}（視窗的 85%）動手，`
              + '剩下的空間留給摘要請求本身和它之後的回覆。'
              + '自動壓縮預設就是開的，這三個值也都有內建預設（16384／20000），'
              + '所以你的檔案裡多半根本沒有 compaction 這一區——要改就得自己加上整區。'
              + `keepRecentTokens 是保留不摘要的最近對話，這裡取視窗的六分之一（${keepRecent.toLocaleString()}）。`
              + '不想自動壓縮就把 enabled 設成 false，改用 /compact 手動觸發。',
        },
      ],
    },
    {
      key: 'curl',
      label: 'curl',
      group: 'raw',
      caption: 'chat_template_kwargs 關掉思考模式——留著的話回覆會先產一段 <think>。',
      steps: [
        {
          title: '③ 建立金鑰檔',
          lang: sh,
          body: writeKeyCommand(os),
        },
        {
          title: '④ 送一個請求',
          lang: sh,
          body: win
            ? `$key = (Get-Content -Raw "${KEY_FILE.win}").Trim()
$body = @{
  model = "${modelId}"
  messages = @(@{ role = "user"; content = "你好" })
  max_tokens = ${output}
  chat_template_kwargs = @{ enable_thinking = $false }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "${base}/chat/completions" -Method Post \`
  -Headers @{ Authorization = "Bearer $key" } \`
  -ContentType "application/json" -Body $body`
            : `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $(cat ${KEY_FILE.unix})" \\
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
      steps: [
        {
          title: '③ 建立金鑰檔',
          lang: sh,
          body: writeKeyCommand(os),
        },
        {
          title: '④ 程式',
          lang: 'python',
          body: `from pathlib import Path
from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key=Path.home().joinpath(".tenks-key").read_text().strip(),
)

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
      <Card size="small">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* The machine first, because every command below is different on each
            one and a reader who skips this gets three boxes they cannot run.
            Detected, and still a control: someone reading this on a laptop is
            often setting up the desktop beside it. */}
        <Space size={10} wrap>
          <Text style={{ fontSize: 12, opacity: 0.6, width: 84, display: 'inline-block' }}>
            ① 作業系統
          </Text>
          <Segmented
            size="small"
            value={os}
            onChange={(v) => setOs(v as Os)}
            options={[
              { label: 'macOS', value: 'mac' },
              { label: 'Linux', value: 'linux' },
              { label: 'Windows', value: 'windows' },
            ]}
          />
        </Space>

        {/* Two rows rather than one list: an agent needs a config file and a
            compaction policy, a raw call needs neither, and putting them in one
            strip made curl look like something you configure. Only the row
            holding the selection shows one -- Segmented renders nothing as
            chosen when its value is not among its options. */}
        {groups.map((g) => (
          <Space key={g.key} size={10} wrap>
            <Text style={{ fontSize: 12, opacity: 0.6, width: 84, display: 'inline-block' }}>
              {/* Numbered once: the two rows are one choice, and numbering both
                  would make picking a tool look like two steps. */}
              {g.key === 'agent' ? '② ' : '　 '}{g.label}
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

        {active.steps.map((step) => (
          <div key={step.title}>
            {/* The step name is the block's name, in the block's own header.
                It used to be a line of text above the box with a copy button
                beside it, which put two headers on one listing. */}
            <Code body={step.body} lang={step.lang} name={step.title}
                  onCopy={() => copy(step.body)} />
            {step.note && (
              <Paragraph type="secondary" style={{
                fontSize: 11.5, margin: '6px 0 0', opacity: 0.75,
                paddingLeft: 9, borderLeft: `1px solid ${LINE.faint}`,
              }}>
                {step.note}
              </Paragraph>
            )}
          </div>
        ))}
      </Space>
    </Card>
  );
}
