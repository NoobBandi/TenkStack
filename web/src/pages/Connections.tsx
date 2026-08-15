import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Card, Checkbox, Col, Row, Space, Switch, Tag, Tooltip, Typography,
} from 'antd';
import { GlobalOutlined, LockOutlined, UnlockOutlined } from '@ant-design/icons';
import Endpoints from '../components/Endpoints';
import ClientSnippets from '../components/ClientSnippets';
import {
  fetchChannels, setChannel, setChannelScopes,
  type Channel, type ChannelState,
} from '../api';
import { ACCENT, LINE, MONO } from '../theme';

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
 */

const SCOPES = [
  { key: 'lan', label: '區網', hint: '同一個路由器下的裝置' },
  { key: 'tailscale', label: 'Tailscale', hint: '你的 Tailnet 內的裝置，走加密通道' },
  { key: 'wan', label: '所有介面', hint: '包含未來新增的網路介面。外網另需路由器轉發埠號' },
];

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
      content: `連到 :${channel.port} 的用戶端會立刻失去連線。套用時整個代理會重啟一次，`
        + '主控台本身會短暫中斷約一秒。',
      okText: '關閉',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => run(channel.key, () => setChannel(channel.key, false), `${channel.label} 已關閉`),
    });
  };

  const changeScopes = (channel: Channel, scopes: string[]) => {
    void run(channel.key, () => setChannelScopes(channel.key, scopes), '存取範圍已套用');
  };

  const channels = state?.channels ?? [];
  const addresses = state?.addresses;

  const switches = (
    <Card title="管道" size="small" loading={state === null} style={{ height: '100%' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {channels.map((channel) => {
          const wide = channel.scopes.includes('wan');
          return (
            <div key={channel.key} style={{ borderBottom: `1px solid ${LINE.faint}`, paddingBottom: 14 }}>
              <Space size={10} align="start" style={{ width: '100%' }}>
                <Switch
                  size="small"
                  checked={channel.enabled}
                  loading={busy === channel.key}
                  disabled={!channel.present || busy !== null}
                  onChange={(next) => toggle(channel, next)}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Space size={8} wrap>
                    <Text strong style={{ fontSize: 13 }}>{channel.label}</Text>
                    <Tag style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>
                      :{channel.port}
                    </Tag>
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
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '4px 0 8px' }}>
                    {channel.note}
                  </Text>

                  <Checkbox.Group
                    value={channel.scopes}
                    disabled={!channel.enabled || busy !== null}
                    onChange={(v) => changeScopes(channel, v as string[])}
                  >
                    <Space size={14} wrap>
                      {SCOPES.map((scope) => {
                        const address = addresses?.[scope.key as 'lan' | 'tailscale' | 'wan'];
                        const missing = scope.key !== 'wan' && !address;
                        return (
                          <Tooltip
                            key={scope.key}
                            title={missing ? '這台機器上沒有這個網路' : `${scope.hint}${address ? `（${address}）` : ''}`}
                          >
                            <Checkbox value={scope.key} disabled={missing}>
                              <Text style={{ fontSize: 12 }}>{scope.label}</Text>
                            </Checkbox>
                          </Tooltip>
                        );
                      })}
                    </Space>
                  </Checkbox.Group>

                  <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
                    {wide
                      ? '目前監聽所有介面。'
                      : channel.scopes.length
                        ? `目前只監聽本機與已勾選的網路。`
                        : '目前只監聽本機（127.0.0.1）。'}
                  </Text>
                </div>
              </Space>
            </div>
          );
        })}
        {channels.length === 0 && state !== null && (
          <Text type="secondary" style={{ fontSize: 12 }}>沒有可切換的管道。</Text>
        )}
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 4 }}
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
