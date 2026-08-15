import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Segmented, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import { CopyOutlined, LockOutlined, SafetyCertificateOutlined, UnlockOutlined } from '@ant-design/icons';
import {
  fetchEndpoints, fetchNetwork,
  type Endpoint, type NetworkHost, type NetworkInfo,
} from '../api';

const { Text } = Typography;

function urlFor(endpoint: Endpoint, host: string): string {
  const path = endpoint.path === '/' ? '' : endpoint.path;
  return `${endpoint.scheme}://${host}:${endpoint.port}${path}`;
}

export default function Endpoints() {
  const { message } = AntApp.useApp();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [hostKey, setHostKey] = useState<string>();

  useEffect(() => {
    fetchEndpoints().then(setEndpoints).catch(() => undefined);
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


  return (
    // Fills the column so the two blocks in the top row end level; the
    // shorter one keeps trailing space rather than leaving a ragged edge.
    <Card title="連線方式" size="small" style={{ height: '100%' }}>
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

    </Card>
  );
}
