import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Card, Checkbox, Col, Row, Segmented, Space, Switch, Table,
  Tag, Tooltip, Typography,
} from 'antd';
import { GlobalOutlined, LockOutlined, UnlockOutlined } from '@ant-design/icons';
import Endpoints from '../components/Endpoints';
import ClientSnippets from '../components/ClientSnippets';
import {
  fetchChannels, setChannel, setChannelScopes,
  type Channel, type ChannelState,
} from '../api';
import { ACCENT, MONO } from '../theme';

const { Text } = Typography;

/**
 * Ways in, and which networks may use them.
 *
 * A channel is one Caddy site block in its own file; the switch moves that file
 * and restarts the proxy. Reach is a `bind` directive rather than hostname
 * matching, so a channel closed to Tailscale has no socket on the Tailscale
 * address at all instead of a port that answers 404.
 *
 * The console's own address is not listed, because it is not one of these
 * files -- it lives in the main Caddyfile so that no switch on this page can
 * close the page.
 *
 * ONE ROW PER CHANNEL
 *
 * This was a stack of paragraphs: a switch, a name, a port, an icon, a
 * sentence of explanation, a checkbox group, and then another sentence saying
 * what the checkboxes had just said. The controls were buried in the prose and
 * you had to read the block to find out how to change it. A row puts the two
 * decisions -- who may reach this, and is it open at all -- in fixed places
 * and lets the explanation live where explanations belong, on hover.
 */

/**
 * Reach as one choice rather than three checkboxes.
 *
 * `所有介面` was a checkbox beside `區網` and `Tailscale`, which made it look
 * like a peer of theirs. It is not: with it on, the other two mean nothing,
 * and they stayed checkable anyway. Three exclusive modes say the shape of the
 * thing, and the network list only appears in the one mode that has a list.
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

function reachOf(channel: Channel): string {
  if (channel.scopes.includes('wan')) return 'all';
  return channel.scopes.length ? 'pick' : 'local';
}

export default function Connections() {
  const { message, modal } = AntApp.useApp();
  const [state, setState] = useState<ChannelState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchChannels().then(setState)
      .catch(() => setState({ channels: [], addresses: { lan: null, tailscale: null, wan: '0.0.0.0' } }));
  }, []);

  useEffect(() => { load(); }, [load]);

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

  const toggle = (channel: Channel, next: boolean) => {
    if (next) {
      void run(channel.key, () => setChannel(channel.key, true), `${channel.label} 已開啟`);
      return;
    }
    // Closing is the direction that breaks things for someone else, and the
    // restart interrupts every connection briefly, so it earns a sentence.
    modal.confirm({
      title: `關閉 ${channel.label}？`,
      content: `連到 ${channel.ports.map((p) => `:${p}`).join('、')} 的用戶端會立刻失去連線。`
        + '套用時整個代理會重啟一次，主控台本身會短暫中斷約一秒。',
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
    // Entering 選擇網路 from either end starts with the LAN, because a reach
    // of nothing is what 只有本機 already means and an empty middle mode would
    // be the same setting under a different name.
    return setScopes(channel, channel.scopes.filter((s) => s !== 'wan').length
      ? channel.scopes.filter((s) => s !== 'wan')
      : ['lan']);
  };

  const channels = state?.channels ?? [];
  const addresses = state?.addresses;

  const switches = (
    <Card title="管道" size="small" loading={state === null} style={{ height: '100%' }}>
      <Table<Channel>
        dataSource={channels}
        rowKey="key"
        size="small"
        pagination={false}
        locale={{ emptyText: '沒有可切換的管道。' }}
        columns={[
          {
            title: '管道',
            render: (_, channel) => (
              <Space size={6}>
                <Tooltip title={channel.note}>
                  <Text strong style={{ fontSize: 13 }}>{channel.label}</Text>
                </Tooltip>
                {channel.encrypted ? (
                  <Tooltip title="TLS 加密">
                    <LockOutlined style={{ opacity: 0.5, fontSize: 12 }} />
                  </Tooltip>
                ) : (
                  <Tooltip title="未加密：內容在區網上是明文">
                    <UnlockOutlined style={{ color: ACCENT.warn, fontSize: 12 }} />
                  </Tooltip>
                )}
                {!channel.present && <Tag color="error">設定檔遺失</Tag>}
              </Space>
            ),
          },
          {
            // Every port it opens, not the first one. The ComfyUI channel is a
            // site block per instance, so one switch here governs several.
            title: '連接埠', width: 120, align: 'right' as const,
            render: (_, channel) => (
              <Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>
                {channel.ports.map((port) => `:${port}`).join(' ') || '—'}
              </Text>
            ),
          },
          {
            title: '誰能連', width: 250, align: 'right' as const,
            render: (_, channel) => {
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
                        {NETWORKS.map((network) => {
                          const address = addresses?.[network.key as 'lan' | 'tailscale'];
                          return (
                            <Tooltip
                              key={network.key}
                              title={address
                                ? `${network.hint}（${address}）`
                                : '這台機器上沒有這個網路'}
                            >
                              <Checkbox value={network.key} disabled={!address}>
                                <Text style={{ fontSize: 12 }}>{network.label}</Text>
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
            title: '', width: 60, align: 'right' as const,
            render: (_, channel) => (
              <Switch
                size="small"
                checked={channel.enabled}
                loading={busy === channel.key}
                disabled={!channel.present || busy !== null}
                onChange={(next) => toggle(channel, next)}
              />
            ),
          },
        ]}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 12 }}
        icon={<GlobalOutlined />}
        message="主控台自己的 :8443 不在這裡"
        description="它留在 Caddyfile 主檔中、不受這些開關影響——否則就可能關掉正在操作的這個介面。「所有介面」也不等於對外網開放：那還需要在路由器上轉發埠號。"
      />
    </Card>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={11}>{switches}</Col>
        <Col xs={24} xl={13}><Endpoints /></Col>
      </Row>
      <ClientSnippets />
    </Space>
  );
}
