import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Segmented, Space, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import {
  fetchEndpoints, fetchModels, fetchNetwork,
  type Endpoint, type ModelInfo, type NetworkInfo,
} from '../api';
import { MONO } from '../theme';

const { Paragraph } = Typography;

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

export default function ClientSnippets() {
  const { message } = AntApp.useApp();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [hostKey, setHostKey] = useState<string>();
  const [tab, setTab] = useState('opencode');

  useEffect(() => {
    fetchEndpoints().then(setEndpoints).catch(() => undefined);
    fetchModels().then(setModels).catch(() => undefined);
    fetchNetwork().then((info) => {
      setNetwork(info);
      const current = info.hosts.find((h) => h.host === window.location.hostname);
      setHostKey(current?.key ?? info.hosts[info.hosts.length - 1]?.key);
    }).catch(() => undefined);
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已複製');
    } catch {
      message.warning('瀏覽器不允許複製，請手動選取');
    }
  }, [message]);

  const host = network?.hosts.find((h) => h.key === hostKey) ?? network?.hosts[0];
  const hostname = host?.host ?? window.location.hostname;

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
      label: 'opencode',
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
          // Without these two, opencode assumes a custom provider cannot see
          // and strips images out before the request is sent.
          "attachment": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] },` : ''}
          "limit": { "context": ${ctx}, "output": ${Math.min(32768, ctx)} }
        }
      }
    }
  }
}

// opencode 不會送 chat_template_kwargs，思考模式會是開的，
// 導致完全產不出 tool call。請在「模型」頁的額外參數加上：
//   --reasoning-budget 0`,
    },
    {
      key: 'claude-code',
      label: 'Claude Code',
      code: `# Claude Code 走 Anthropic 自己的 /v1/messages 格式，llama-server 原生支援，
# 主控台的 /v1 代理照樣轉發，認證用它本來就會送的 x-api-key。
#
# 注意 ANTHROPIC_BASE_URL 不要帶 /v1：Claude Code 自己會接上 /v1/messages。

export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="sk-console-..."
export ANTHROPIC_MODEL="${modelId}"
# 背景小工作會另外叫一個「快速模型」，不指定的話它會送 claude-haiku-*，
# 這台沒有那個名字就會失敗。指到同一個模型即可。
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${modelId}"

# 或寫進 ~/.claude/settings.json：
# {
#   "env": {
#     "ANTHROPIC_BASE_URL": "${origin}",
#     "ANTHROPIC_AUTH_TOKEN": "sk-console-...",
#     "ANTHROPIC_MODEL": "${modelId}",
#     "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${modelId}"
#   }
# }
#
# config.yaml 裡另外掛了 claude-opus-5／claude-sonnet-5／claude-haiku-4-5
# 這幾個別名指向同一個模型，所以硬寫死模型名的工具也能通。`,
    },
    {
      key: 'codex',
      label: 'Codex',
      code: `# ~/.codex/config.toml
#
# Codex 只講 OpenAI 協定，而且從 2026 年 2 月起只剩 Responses API
# （wire_api = "chat" 已移除）。llama-server 有 /v1/responses，所以能用。
# 先在 shell 設好金鑰：export TENKS_KEY=sk-console-...

model_provider = "tenks"
model = "${modelId}"

[model_providers.tenks]
name = "TenkStack"
base_url = "${base}"
env_key = "TENKS_KEY"
wire_api = "responses"

# 內建的 provider id（openai／ollama／lmstudio）不能覆寫，所以取一個自己的名字。
# 別名 gpt-5-codex／gpt-5 也指向同一個模型。`,
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
    <Card
      title="用戶端設定範例"
      size="small"
      extra={
        network && network.hosts.length > 1 && (
          <Segmented
            size="small"
            value={hostKey}
            onChange={(v) => setHostKey(v as string)}
            options={network.hosts.map((h) => ({ label: h.label, value: h.key }))}
          />
        )
      }
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space size={10} wrap>
          <Segmented
            size="small"
            value={tab}
            onChange={(v) => setTab(v as string)}
            options={snippets.map((s) => ({ label: s.label, value: s.key }))}
          />
          <Button type="text" size="small" icon={<CopyOutlined />}
                  onClick={() => copy(active.code)}>
            複製
          </Button>
        </Space>

        <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
          位址與模型 id 取自這台機器目前的狀態。API key 到「使用者」頁建立，只會顯示一次。
        </Paragraph>

        <pre style={{
          background: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 6,
          overflowX: 'auto', margin: 0, fontSize: 12, lineHeight: 1.55,
          fontFamily: MONO,
        }}>
          <code>{active.code}</code>
        </pre>
      </Space>
    </Card>
  );
}
