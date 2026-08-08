import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Collapse, Segmented, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import { CopyOutlined, LockOutlined, SafetyCertificateOutlined, UnlockOutlined } from '@ant-design/icons';
import {
  fetchEndpoints, fetchModels, fetchNetwork,
  type Endpoint, type ModelInfo, type NetworkHost, type NetworkInfo,
} from '../api';

const { Text, Paragraph } = Typography;

function urlFor(endpoint: Endpoint, host: string): string {
  const path = endpoint.path === '/' ? '' : endpoint.path;
  return `${endpoint.scheme}://${host}:${endpoint.port}${path}`;
}

export default function Endpoints() {
  const { message } = AntApp.useApp();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [hostKey, setHostKey] = useState<string>();

  useEffect(() => {
    fetchEndpoints().then(setEndpoints).catch(() => undefined);
    fetchModels().then(setModels).catch(() => undefined);
    fetchNetwork()
      .then((info) => {
        setNetwork(info);
        // Default to whichever address the console was actually opened on, so
        // the URLs shown are the ones already known to work from here.
        const current = info.hosts.find((h) => h.host === window.location.hostname);
        setHostKey(current?.key ?? info.hosts[info.hosts.length - 1]?.key);
      })
      .catch(() => undefined);
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已複製');
    } catch {
      // Clipboard access needs a secure context; over plain HTTP it is blocked.
      message.warning('瀏覽器不允許複製，請手動選取');
    }
  }, [message]);

  const host: NetworkHost | undefined =
    network?.hosts.find((h) => h.key === hostKey) ?? network?.hosts[0];
  const hostname = host?.host ?? window.location.hostname;

  const apiBase = endpoints.find((e) => e.key === 'api-http') ?? endpoints.find((e) => e.key === 'api-https');
  const base = apiBase ? urlFor(apiBase, hostname) : 'http://<host>:8000/v1';
  const modelId = models[0]?.id ?? '<model-id>';

  const snippets: { key: string; label: string; code: string }[] = [
    {
      key: 'curl',
      label: 'curl',
      code: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $AI_CONSOLE_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "messages": [{"role": "user", "content": "你好"}],
    "chat_template_kwargs": {"enable_thinking": false}
  }'`,
    },
    {
      key: 'python',
      label: 'Python (OpenAI SDK)',
      code: `from openai import OpenAI

client = OpenAI(base_url="${base}", api_key="sk-console-...")

resp = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "你好"}],
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
)
print(resp.choices[0].message.content)`,
    },
    {
      key: 'opencode',
      label: 'opencode',
      code: `// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AI Console",
      "options": {
        "baseURL": "${base}",
        "apiKey": "{env:AI_CONSOLE_KEY}"
      },
      "models": {
        "${modelId}": { "name": "${models[0]?.name || modelId}" }
      }
    }
  }
}

// opencode 不會送 chat_template_kwargs，思考模式會是開的，
// 導致完全產不出 tool call。請在「模型」頁的額外參數加上：
//   --reasoning-budget 0`,
    },
  ];

  return (
    <Card title="連線方式" size="small">
      {network && network.hosts.length > 1 && (
        <Space direction="vertical" size={6} style={{ width: '100%', marginBottom: 12 }}>
          <Segmented
            size="small"
            value={hostKey}
            onChange={(v) => setHostKey(v as string)}
            options={network.hosts.map((h) => ({ label: h.label, value: h.key }))}
          />
          {host && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {host.host} ・ {host.note}
            </Text>
          )}
        </Space>
      )}

      {host?.tailscale && (
        <Alert
          type={host.cert_available ? 'success' : 'info'}
          showIcon
          icon={<SafetyCertificateOutlined />}
          style={{ marginBottom: 12 }}
          message={host.cert_available
            ? 'Tailscale 網域可取得公開信任的憑證'
            : 'Tailscale 傳輸本身已由 WireGuard 加密'}
          description={host.cert_available
            ? '若瀏覽器仍顯示憑證警告，代表 Caddy 尚未取得憑證。在這台機器上執行一次 sudo tailscale set --operator=$USER 後即會自動取得，不需要改設定。'
            : 'IP 位址無法簽發公開憑證，請改用上方的 Tailscale 網域名稱。走 Tailscale 時即使是純 HTTP 也不會有明文外洩，流量在網路層已加密。'}
        />
      )}

      <Table<Endpoint>
        dataSource={endpoints}
        rowKey="key"
        size="small"
        pagination={false}
        showHeader={false}
        locale={{ emptyText: '讀取中…' }}
        columns={[
          {
            title: '',
            width: 130,
            render: (_, row) => (
              <Space size={6}>
                <Text strong>{row.label}</Text>
                {row.encrypted ? (
                  <Tooltip title="TLS 加密"><LockOutlined style={{ opacity: 0.5 }} /></Tooltip>
                ) : (
                  <Tooltip title="未加密：憑證內容在區網上是明文">
                    <UnlockOutlined style={{ color: '#d48806' }} />
                  </Tooltip>
                )}
              </Space>
            ),
          },
          {
            title: '',
            render: (_, row) => (
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Space size={6}>
                  <Text code copyable={false} style={{ fontSize: 13 }}>{urlFor(row, hostname)}</Text>
                  <Button type="text" size="small" icon={<CopyOutlined />}
                          onClick={() => copy(urlFor(row, hostname))} />
                  {!row.listening && <Tag color="error">未監聽</Tag>}
                </Space>
                <Text type="secondary" style={{ fontSize: 12 }}>{row.note}</Text>
              </Space>
            ),
          },
        ]}
      />

      <Collapse
        ghost
        size="small"
        style={{ marginTop: 8 }}
        items={[{
          key: 'snippets',
          label: <Text style={{ fontSize: 13 }}>用戶端設定範例</Text>,
          children: (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                API key 到「使用者」頁建立，只會顯示一次。
              </Paragraph>
              {snippets.map((snippet) => (
                <div key={snippet.key}>
                  <Space size={8} style={{ marginBottom: 4 }}>
                    <Text strong style={{ fontSize: 13 }}>{snippet.label}</Text>
                    <Button type="text" size="small" icon={<CopyOutlined />}
                            onClick={() => copy(snippet.code)} />
                  </Space>
                  <pre style={{
                    background: 'rgba(128,128,128,0.12)', padding: 12, borderRadius: 6,
                    overflowX: 'auto', margin: 0, fontSize: 12, lineHeight: 1.5,
                  }}>
                    <code>{snippet.code}</code>
                  </pre>
                </div>
              ))}
            </Space>
          ),
        }]}
      />
    </Card>
  );
}
