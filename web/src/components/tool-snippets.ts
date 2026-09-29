import { type ModelInfo } from '../api';
import {
  openCommand, shellLang, writeKeyCommand,
  KEY_FILE, KEY_FILE_ABS, KEY_PLACEHOLDER, type Os, type Snippet,
} from './snippet-types';

/**
 * Each tool's steps, written from what the connections page has decided: the
 * address, the model and, once one is made there, the key. Data only; the
 * page draws it with ToolSteps in ClientSnippets.
 */

/** What the page has decided, which every tool's steps are written from. */
export interface Target {
  /** The OpenAI-style base, ending in /v1. */
  base: string;
  /** The same server without /v1, for Claude Code, which appends it itself. */
  origin: string;
  model: ModelInfo | null;
  /** A key made on the page just now, or null for the placeholder. */
  apiKey: string | null;
}

export function snippetsFor({ base, origin, model, apiKey }: Target, os: Os): Snippet[] {
  const key = apiKey ?? KEY_PLACEHOLDER;
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
  // written out separately, and a reader comparing two tools sees one policy.
  const compactAt = Math.floor(ctx * 0.85);
  const reserved = ctx - compactAt;
  const keepRecent = Math.floor(ctx / 6);

  const win = os === 'windows';
  const keyPath = win ? KEY_FILE.win : KEY_FILE.unix;
  const keyAbs = os === 'mac' ? KEY_FILE_ABS.mac : KEY_FILE_ABS.unix;
  const sh = shellLang(os);

  return [
    {
      key: 'opencode',
      label: 'Opencode',
      blurb: '開源的終端機編碼代理',
      group: 'agent',
      caption: 'compaction 的欄位名以 $schema 指向的實際 schema 為準——文件上寫的 keep.tokens／buffer 是另一版，填了不會生效。',
      steps: [
        {
          title: '開啟設定檔',
          lang: sh,
          body: openCommand(os, '~/.config/opencode/opencode.json',
            '$env:USERPROFILE\\.config\\opencode\\opencode.json'),
        },
        {
          title: '貼進去：模型參數',
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
          title: '金鑰：在 opencode 裡打',
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
      blurb: 'Anthropic 的終端機編碼代理',
      group: 'agent',
      caption: 'ANTHROPIC_BASE_URL 不要帶 /v1，Claude Code 自己會接上 /v1/messages。env 裡的值一律是字串，數字也要加引號。',
      steps: [
        {
          title: '開啟設定檔',
          lang: sh,
          body: openCommand(os, '~/.claude/settings.json',
            '$env:USERPROFILE\\.claude\\settings.json'),
        },
        {
          title: '貼進去：模型參數',
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
          title: '建立金鑰檔',
          lang: sh,
          body: writeKeyCommand(os, key),
        },
      ],
    },
    {
      key: 'codex',
      label: 'Codex',
      blurb: 'OpenAI 的終端機編碼代理',
      group: 'agent',
      caption: 'Codex 只講 OpenAI 協定，而且從 2026 年 2 月起只剩 Responses API（wire_api = "chat" 已移除）；'
             + 'llama-server 有 /v1/responses 所以能用。內建的 provider id（openai／ollama／lmstudio）不能覆寫，要取自己的名字。',
      steps: [
        {
          title: '開啟設定檔',
          lang: sh,
          body: openCommand(os, '~/.codex/config.toml',
            '$env:USERPROFILE\\.codex\\config.toml'),
        },
        {
          title: '貼進去：模型參數',
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
          title: '建立金鑰檔',
          lang: sh,
          body: writeKeyCommand(os, key),
        },
      ],
    },
    {
      key: 'grok',
      label: 'Grok Build',
      blurb: 'xAI 的終端機編碼代理',
      group: 'agent',
      caption: 'api_backend 選 chat_completions，llama-server 這條路最穩。',
      steps: [
        {
          title: '開啟設定檔',
          lang: sh,
          body: openCommand(os, '~/.grok/config.toml',
            '$env:USERPROFILE\\.grok\\config.toml'),
        },
        {
          title: '貼進去：模型參數',
          lang: 'ini',
          body: `[model.tenks-${modelId}]
model = "${modelId}"
base_url = "${base}"
name = "${modelName}（本機）"
api_key = "${key}"
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
      blurb: '可自己擴充的終端機編碼代理',
      group: 'agent',
      caption: 'Pi 的自訂 provider 走 ~/.pi/agent/models.json；'
             + '另一條 pi.registerProvider() 是寫 extension 用的，接一台自架伺服器不需要走到那裡。'
             + '這個檔案每次打開 /model 都會重讀，改完不用重開。',
      steps: [
        {
          title: '開啟模型設定檔',
          lang: sh,
          body: openCommand(os, '~/.pi/agent/models.json',
            '$env:USERPROFILE\\.pi\\agent\\models.json'),
        },
        {
          title: '貼進去：模型參數',
          lang: 'json',
          body: JSON.stringify({
            providers: {
              tenks: {
                baseUrl: base,
                api: 'openai-completions',
                apiKey: key,
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
          title: '開啟 agent 設定檔',
          lang: sh,
          body: openCommand(os, '~/.pi/agent/settings.json',
            '$env:USERPROFILE\\.pi\\agent\\settings.json'),
        },
        {
          title: '貼進去：什麼時候壓縮上下文',
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
      blurb: '送一個請求試試看',
      group: 'raw',
      caption: 'chat_template_kwargs 關掉思考模式——留著的話回覆會先產一段 <think>。',
      steps: [
        {
          title: '建立金鑰檔',
          lang: sh,
          body: writeKeyCommand(os, key),
        },
        {
          title: '送一個請求',
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
      blurb: '用 openai 套件寫程式',
      group: 'raw',
      caption: '用官方 openai 套件，指向這台的 base_url 就好。',
      steps: [
        {
          title: '建立金鑰檔',
          lang: sh,
          body: writeKeyCommand(os, key),
        },
        {
          title: '程式',
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
}

