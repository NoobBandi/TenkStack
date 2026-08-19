import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Segmented, Space, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { fetchModels, type Endpoint, type ModelInfo } from '../api';
import { MONO } from '../theme';

const { Paragraph } = Typography;

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
  // Which shell the second box is written for. Only some snippets have one, and
  // the difference is not cosmetic: `export` and `$env:` are different
  // languages, and on Windows the second one lasts only as long as the window.
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
  const vision = model?.capabilities?.vision ?? false;
  const ctx = model?.ctx_size ?? 32768;

  const snippets = [
    {
      key: 'opencode',
      label: 'Opencode',
      code: `// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "TenkStack",
      "options": {
        "baseURL": "${base}",
        "apiKey": "{env:AI_CONSOLE_KEY}"
      },
      "models": {
        "${modelId}": {
          "name": "${model?.name || modelId}",${vision ? `
          // Without these two, Opencode assumes a custom provider cannot see
          // and strips images out before the request is sent.
          "attachment": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] },` : ''}
          "limit": { "context": ${ctx}, "output": ${Math.min(32768, ctx)} }
        }
      }
    }
  }
}

// Opencode 不會送 chat_template_kwargs，思考模式會是開的，
// 導致完全產不出 tool call。請在「模型」頁的額外參數加上：
//   --reasoning-budget 0`,
    },
    {
      key: 'claude-code',
      label: 'Claude Code',
      caption: 'Linux／macOS 放 ~/.claude/settings.json，Windows 放 %USERPROFILE%\\.claude\\settings.json。'
             + 'ANTHROPIC_BASE_URL 不要帶 /v1，Claude Code 自己會接上 /v1/messages。'
             + '背景小工作會另外叫一個「快速模型」，不指定就會送 claude-haiku-*，這台沒有那個名字，'
             + '所以兩個都要設。',
      code: `{
  "env": {
    "ANTHROPIC_BASE_URL": "${origin}",
    "ANTHROPIC_AUTH_TOKEN": "sk-console-...",
    "ANTHROPIC_MODEL": "${modelId}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${modelId}"
  }
}`,
      shellCaption: '不想改設定檔就用環境變數跑一次。PowerShell 的 $env: 只在這個視窗有效，'
                  + '要留著改用 setx（新開的視窗才會生效）。',
      shell: {
        linux: `export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="sk-console-..."
export ANTHROPIC_MODEL="${modelId}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${modelId}"
claude`,
        windows: `$env:ANTHROPIC_BASE_URL = "${origin}"
$env:ANTHROPIC_AUTH_TOKEN = "sk-console-..."
$env:ANTHROPIC_MODEL = "${modelId}"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "${modelId}"
claude`,
      },
    },
    {
      key: 'codex',
      label: 'Codex',
      caption: 'Linux／macOS 放 ~/.codex/config.toml，Windows 放 %USERPROFILE%\\.codex\\config.toml。'
             + 'Codex 只講 OpenAI 協定，而且從 2026 年 2 月起只剩 Responses API'
             + '（wire_api = "chat" 已移除）；llama-server 有 /v1/responses 所以能用。'
             + '內建的 provider id（openai／ollama／lmstudio）不能覆寫，要取自己的名字。',
      code: `model_provider = "tenks"
model = "${modelId}"

[model_providers.tenks]
name = "TenkStack"
base_url = "${base}"
env_key = "TENKS_KEY"
wire_api = "responses"`,
      shellCaption: '金鑰不寫在設定檔裡，Codex 只記變數名稱，值從環境變數讀。',
      shell: {
        linux: `export TENKS_KEY="sk-console-..."
codex`,
        windows: `$env:TENKS_KEY = "sk-console-..."
codex`,
      },
    },
    {
      key: 'grok',
      label: 'Grok Build',
      code: `# ~/.grok/config.toml
#
# Grok Build 讀 OpenAI Chat Completions 協定，所以指向這台就好。
# 先在 shell 設好金鑰：export TENKS_KEY=sk-console-...

[model.tenks-${modelId}]
model = "${modelId}"
base_url = "${base}"
name = "${model?.name || modelId}（本機）"
env_key = "TENKS_KEY"

[models]
default = "tenks-${modelId}"

# 驗證有沒有讀到：
#   grok inspect
# 指定執行：
#   grok -p "你好" -m tenks-${modelId}
# 互動模式內切換：
#   /model tenks-${modelId}`,
    },
    {
      key: 'curl',
      label: 'curl',
      code: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $TENKS_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "messages": [{"role": "user", "content": "你好"}],
    "chat_template_kwargs": {"enable_thinking": false}
  }'`,
    },
    {
      key: 'python',
      label: 'Python',
      code: `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="sk-console-...")

resp = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "你好"}],
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)
print(resp.choices[0].message.content)`,
    },
  ];

  const active = snippets.find((s) => s.key === tab) ?? snippets[0];

  return (
    <Card title="用戶端設定範例" size="small">
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space size={10} wrap>
          <Segmented
            size="small"
            value={tab}
            onChange={(v) => onTab(v as string)}
            options={snippets.map((s) => ({ label: s.label, value: s.key }))}
          />
          <Button type="text" size="small" icon={<CopyOutlined />}
                  onClick={() => copy(active.code)}>
            複製
          </Button>
        </Space>

        <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
          {active.caption
            ?? '位址與模型 id 取自這台機器目前的狀態。API key 到「使用者」頁建立，只會顯示一次。'}
        </Paragraph>

        <pre style={BOX}><code>{active.code}</code></pre>

        {/* The second box exists because the first one is a file and this is
            something you type. Keeping them apart is the difference between a
            config to paste and a command to run -- and the command is not the
            same command on both platforms. */}
        {active.shell && (
          <>
            <Space size={10} wrap style={{ marginTop: 2 }}>
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
              <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                {active.shellCaption}
              </Paragraph>
            )}

            <pre style={BOX}><code>{active.shell[shell]}</code></pre>
          </>
        )}
      </Space>
    </Card>
  );
}
