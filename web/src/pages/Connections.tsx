import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Checkbox, Segmented, Space, Switch, Table, Tag,
  Tooltip, Typography,
} from 'antd';
import {
  GlobalOutlined, LockOutlined, SafetyCertificateOutlined, UnlockOutlined,
} from '@ant-design/icons';
import ClientSnippets from '../components/ClientSnippets';
import {
  fetchChannels, fetchEndpoints, fetchNetwork, setChannel, setChannelScopes,
  type Channel, type ChannelState, type Endpoint, type NetworkHost, type NetworkInfo,
} from '../api';
import { ACCENT } from '../theme';

const { Text } = Typography;

/**
 * Every way in, in one table.
 *
 * This was three cards, and the same decision was made twice in it: the
 * endpoint list had a host selector and the client snippets had another, and
 * they did not agree -- so copying an address from one and a config from the
 * other gave you a snippet pointing somewhere you had not chosen. Meanwhile
 * the thing that decides whether any of it works, the channel switch and its
 * reach, sat in a third card with no visible connection to the address it
 * governs.
 *
 * One source selector at the top, one row per way in, and the address, who may
 * reach it, and whether it is open at all read across a single line.
 *
 * A channel is one Caddy site block in its own file; the switch moves that file
 * and reloads the proxy. Reach is a `bind` directive rather than hostname
 * matching, so a channel closed to Tailscale has no socket on the Tailscale
 * address at all instead of a port that answers 404. Two rows have no channel:
 * the console and the API it carries live in the main Caddyfile, so that no
 * switch on this page can close the page it is drawn on.
 */

/**
 * Reach as one choice rather than three checkboxes.
 *
 * `所有介面` was a checkbox beside `區網` and `Tailscale`, which made it look
 * like a peer of theirs. It is not: with it on, the other two mean nothing,
 * and they stayed checkable anyway.
 */
const REACH = [
  { value: 'local', label: '只有本機' },
  { value: 'pick', label: '選擇網路' },
  { value: 'all', label: '所有介面' },
];

const NETWORKS = [
  { key: 'lan', label: '區網', hint: '同一個路由器下的裝置' },
  { key: 'tailscale', label: 'Tailscale', hint: '你的 Tailnet 內的裝置，走加密通道' },
];

/** Which snippet tab an endpoint's 範例 button opens. */
const SNIPPET_FOR: Record<string, string> = {
  'api-http': 'opencode',
  'api-https': 'claude-code',
};

function reachOf(channel: Channel): string {
  if (channel.scopes.includes('wan')) return 'all';
  return channel.scopes.length ? 'pick' : 'local';
}

export default function Connections() {
  const { message, modal } = AntApp.useApp();
  const [state, setState] = useState<ChannelState | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [hostKey, setHostKey] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState('opencode');

  const load = useCallback(() => {
    fetchChannels().then(setState)
      .catch(() => setState({ channels: [], addresses: { lan: null, tailscale: null, wan: '0.0.0.0' } }));
  }, []);

  useEffect(() => {
    load();
    fetchEndpoints().then(setEndpoints).catch(() => undefined);
    fetchNetwork().then((info) => {
      setNetwork(info);
      // Default to whichever address the console was actually opened on, so
      // the addresses shown are the ones already known to work from here.
      const current = info.hosts.find((h) => h.host === window.location.hostname);
      setHostKey(current?.key ?? info.hosts[info.hosts.length - 1]?.key);
    }).catch(() => undefined);
  }, [load]);

  const run = async (key: string, action: () => Promise<{ changed: boolean } & ChannelState>,
                     done: string) => {
    setBusy(key);
    try {
      setState(await action());
      message.success(done);
    } catch (error) {
      message.error((error as Error).message);
      load();
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已複製');
    } catch {
      // Clipboard access needs a secure context; over plain HTTP it is blocked.
      message.warning('瀏覽器不允許複製，請手動選取');
    }
  };

  const toggle = (channel: Channel, next: boolean) => {
    if (next) {
      void run(channel.key, () => setChannel(channel.key, true), `${channel.label} 已開啟`);
      return;
    }
    // Closing is the direction that breaks things for someone else, and the
    // reload interrupts connections briefly, so it earns a sentence.
    modal.confirm({
      title: `關閉 ${channel.label}？`,
      content: `連到 ${channel.ports.map((p) => `:${p}`).join('、')} 的用戶端會立刻失去連線。`,
      okText: '關閉',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => run(channel.key, () => setChannel(channel.key, false), `${channel.label} 已關閉`),
    });
  };

  const setScopes = (channel: Channel, scopes: string[]) =>
    run(channel.key, () => setChannelScopes(channel.key, scopes), '存取範圍已套用');

  const setReach = (channel: Channel, reach: string) => {
    if (reach === 'all') return setScopes(channel, ['wan']);
    if (reach === 'local') return setScopes(channel, []);
    // Entering 選擇網路 from either end starts with the LAN: a reach of nothing
    // is what 只有本機 already means, and an empty middle mode would be the
    // same setting under a different name.
    const kept = channel.scopes.filter((s) => s !== 'wan');
    return setScopes(channel, kept.length ? kept : ['lan']);
  };

  const host: NetworkHost | undefined =
    network?.hosts.find((h) => h.key === hostKey) ?? network?.hosts[0];
  const hostname = host?.host ?? window.location.hostname;
  const channels = state?.channels ?? [];
  const addresses = state?.addresses;

  /** One row per way in: the endpoint, and the channel governing it if any. */
  const rows = useMemo(() => endpoints.map((endpoint) => ({
    endpoint,
    channel: channels.find((c) => c.key === endpoint.key) ?? null,
  })), [endpoints, channels]);

  const urls = (row: { endpoint: Endpoint; channel: Channel | null }) => {
    const path = row.endpoint.path === '/' ? '' : row.endpoint.path;
    const ports = row.channel?.ports.length ? row.channel.ports : [row.endpoint.port];
    return ports.map((port) => `${row.endpoint.scheme}://${hostname}:${port}${path}`);
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="連線"
        size="small"
        loading={state === null}
        extra={network && network.hosts.length > 1 && (
          <Space size={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>從哪裡連</Text>
            <Segmented
              size="small"
              value={hostKey}
              onChange={(v) => setHostKey(v as string)}
              options={network.hosts.map((h) => ({ label: h.label, value: h.key }))}
            />
          </Space>
        )}
      >
        {host && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
            {host.host} ・ {host.note}
          </Text>
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

        <Table
          dataSource={rows}
          rowKey={(row) => row.endpoint.key}
          size="small"
          pagination={false}
          locale={{ emptyText: '讀取中…' }}
          columns={[
            {
              title: '入口', width: 150,
              render: (_, row) => (
                <Space size={6}>
                  <Tooltip title={row.endpoint.note}>
                    <Text strong style={{ fontSize: 13 }}>{row.endpoint.label}</Text>
                  </Tooltip>
                  {row.endpoint.encrypted ? (
                    <Tooltip title="TLS 加密">
                      <LockOutlined style={{ opacity: 0.5, fontSize: 12 }} />
                    </Tooltip>
                  ) : (
                    <Tooltip title="未加密：內容在區網上是明文">
                      <UnlockOutlined style={{ color: ACCENT.warn, fontSize: 12 }} />
                    </Tooltip>
                  )}
                  {row.channel && !row.channel.present && <Tag color="error">設定檔遺失</Tag>}
                </Space>
              ),
            },
            {
              // One line per port: a channel is no longer one site block, so
              // the ComfyUI row has an address per card.
              title: '網址',
              render: (_, row) => (
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  {/* The address is what the page is for, so it is the
                      largest thing in the row -- and clicking it copies, which
                      is what the button beside it used to be for. One target
                      instead of two, and the bigger one. */}
                  {urls(row).map((url) => (
                    <Tooltip key={url} title="點一下複製">
                      <Text code style={{ fontSize: 14, cursor: 'pointer' }}
                            onClick={() => copy(url)}>
                        {url}
                      </Text>
                    </Tooltip>
                  ))}
                  {!row.endpoint.listening && <Tag color="error">未監聽</Tag>}
                </Space>
              ),
            },
            {
              title: '誰能連', width: 250, align: 'right' as const,
              render: (_, row) => {
                const channel = row.channel;
                if (!channel) {
                  // The console and the API it carries are the same site block
                  // in the main Caddyfile. Saying so is more useful than an
                  // empty cell, and the two want different words: one *is* the
                  // console, the other rides on it.
                  const rides = row.endpoint.key !== 'console';
                  return (
                    <Tooltip title="它在 Caddyfile 主檔中，不受這頁的開關影響——否則就可能關掉正在操作的這個介面">
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {rides ? '跟主控台一起' : '這個介面本身'}
                      </Text>
                    </Tooltip>
                  );
                }
                const reach = reachOf(channel);
                return (
                  <Space direction="vertical" size={4} align="end" style={{ width: '100%' }}>
                    <Segmented
                      size="small"
                      value={reach}
                      disabled={!channel.enabled || busy !== null}
                      options={REACH}
                      onChange={(v) => setReach(channel, String(v))}
                    />
                    {reach === 'pick' && (
                      <Checkbox.Group
                        value={channel.scopes}
                        disabled={busy !== null}
                        onChange={(v) => setScopes(channel, v as string[])}
                      >
                        <Space size={10}>
                          {NETWORKS.map((network_) => {
                            const address = addresses?.[network_.key as 'lan' | 'tailscale'];
                            return (
                              <Tooltip
                                key={network_.key}
                                title={address ? `${network_.hint}（${address}）` : '這台機器上沒有這個網路'}
                              >
                                <Checkbox value={network_.key} disabled={!address}>
                                  <Text style={{ fontSize: 12 }}>{network_.label}</Text>
                                </Checkbox>
                              </Tooltip>
                            );
                          })}
                        </Space>
                      </Checkbox.Group>
                    )}
                  </Space>
                );
              },
            },
            {
              title: '範例', width: 80, align: 'right' as const,
              render: (_, row) => (SNIPPET_FOR[row.endpoint.key] ? (
                <Button type="link" size="small" style={{ padding: 0 }}
                        onClick={() => setTab(SNIPPET_FOR[row.endpoint.key])}>
                  設定範例
                </Button>
              ) : null),
            },
            {
              title: '', width: 60, align: 'right' as const,
              render: (_, row) => (row.channel ? (
                <Switch
                  size="small"
                  checked={row.channel.enabled}
                  loading={busy === row.channel.key}
                  disabled={!row.channel.present || busy !== null}
                  onChange={(next) => toggle(row.channel!, next)}
                />
              ) : null),
            },
          ]}
        />

        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          icon={<GlobalOutlined />}
          message="「所有介面」不等於對外網開放"
          description="那還需要在路由器上轉發埠號。沒有開關的那幾列住在 Caddyfile 主檔裡，這頁關不掉它們——否則就可能關掉正在操作的這個介面。"
        />
      </Card>

      <ClientSnippets endpoints={endpoints} hostname={hostname} tab={tab} onTab={setTab} />
    </Space>
  );
}
