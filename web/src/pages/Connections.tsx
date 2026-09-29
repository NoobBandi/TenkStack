import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntApp, Button, Card, Checkbox, Input, Modal, Segmented, Select, Space, Switch, Tag, Tooltip,
  Typography,
} from 'antd';
import { CopyOutlined, InfoCircleOutlined, KeyOutlined, RightOutlined, WarningFilled } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { ToolSteps } from '../components/ClientSnippets';
import { snippetsFor } from '../components/tool-snippets';
import { detectOs, type Os } from '../components/snippet-types';
import { Row } from '../components/Panel';
import {
  createApiKey, fetchChannels, fetchEndpoints, fetchLastUsedModel, fetchModels, fetchNetwork,
  setChannel, setChannelScopes,
  type Channel, type ChannelState, type Endpoint, type ModelInfo, type NetworkHost, type NetworkInfo,
} from '../api';
import { useAuthState, useIsOwner } from '../identity';
import { useMedia } from '../media';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * How to reach this machine's models, laid out as the work goes.
 *
 * On the left, what nearly every tool wants -- where it runs from, the API's
 * address, a key, a model name -- and under it the tools, as a list. On the
 * right, the chosen tool's steps, with those values already written in. Below,
 * across the page, the ways in: the console, the API and ComfyUI, their
 * addresses, and for the administrator who may reach each.
 *
 * This used to open on the network table -- 入口, 純 HTTP and 加密, 只有本機,
 * 選擇網路 and 所有介面, switches -- the administrator's question asked of
 * everyone first, while the key was a sentence in small print and a
 * thirty-line config took most of the page.
 *
 * A channel is one Caddy site block in its own file; its switch moves that
 * file and reloads the proxy. Reach is a `bind` directive rather than hostname
 * matching, so a channel closed to Tailscale has no socket on the Tailscale
 * address at all. The console, and the encrypted API it carries, live in the
 * main Caddyfile, so that no switch here can close the page it is drawn on.
 */

const REACH = [
  { value: 'local', label: '只有這台' },
  { value: 'pick', label: '指定網路' },
  { value: 'all', label: '所有網路' },
];

const NETWORKS = [
  { key: 'lan', label: '區域網路', hint: '同一個路由器下的裝置' },
  { key: 'tailscale', label: 'Tailscale', hint: '你的 Tailnet 內的裝置，走加密通道' },
];

function reachOf(channel: Channel): string {
  if (channel.scopes.includes('wan')) return 'all';
  return channel.scopes.length ? 'pick' : 'local';
}

/** Whether a channel answers on the network a host is on. */
function reaches(channel: Channel, host: NetworkHost): boolean {
  if (!channel.enabled) return false;
  if (host.key === 'local' || channel.scopes.includes('wan')) return true;
  return channel.scopes.includes(host.tailscale ? 'tailscale' : host.key);
}

/** A name with an optional info mark, and something at the right. */
function Label({ children, info, extra }: {
  children: React.ReactNode; info?: React.ReactNode; extra?: React.ReactNode;
}) {
  return (
    <div style={{ fontSize: 12, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ opacity: 0.6 }}>{children}</span>
      {info && (
        <Tooltip title={info} styles={{ root: { maxWidth: 360 } }}>
          <InfoCircleOutlined style={{ fontSize: 11, cursor: 'help', opacity: 0.6 }} />
        </Tooltip>
      )}
      {extra && <span style={{ marginInlineStart: 'auto' }}>{extra}</span>}
    </div>
  );
}

/**
 * One of the things a tool needs, stacked: its name, the value, a line. The
 * values are all the same shape -- a full-width box, a copy button at its end
 * where there is something to copy -- so the four read as one form.
 */
function Fact({ title, info, extra, note, children }: {
  title: string; info?: React.ReactNode; extra?: React.ReactNode; note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: '12px 16px' }}>
      <Label info={info} extra={extra}>{title}</Label>
      {children}
      {note && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6, lineHeight: 1.6 }}>{note}</Text>
      )}
    </div>
  );
}

export default function Connections() {
  const { message, modal } = AntApp.useApp();
  const owner = useIsOwner();
  const auth = useAuthState();
  const wide = useMedia('(min-width: 1100px)');
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [state, setState] = useState<ChannelState | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [hostKey, setHostKey] = useState<string>();
  const [modelId, setModelId] = useState<string>();
  const [tool, setTool] = useState('claude-code');
  const [os, setOs] = useState<Os>(detectOs);
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState<{ name: string; secret: string } | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [creating, setCreating] = useState(false);

  const loadChannels = useCallback(() => {
    // Members may not read the channels; the address then goes unchecked.
    fetchChannels().then(setState).catch(() => setState(null));
  }, []);

  useEffect(() => {
    loadChannels();
    fetchEndpoints().then(setEndpoints).catch(() => undefined);
    fetchModels().then(setModels).catch(() => undefined);
    fetchLastUsedModel().then(setLastUsed).catch(() => undefined);
    fetchNetwork().then((info) => {
      setNetwork(info);
      // Whichever address the console was opened on: it already works from here.
      const current = info.hosts.find((h) => h.host === window.location.hostname);
      setHostKey(current?.key ?? info.hosts.find((h) => h.key === 'lan')?.key ?? info.hosts[0]?.key);
    }).catch(() => undefined);
  }, [loadChannels]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已複製');
    } catch {
      // Clipboard access needs a secure context; over plain HTTP it is blocked.
      message.warning('瀏覽器不允許複製，請手動選取');
    }
  };

  const host: NetworkHost | undefined =
    network?.hosts.find((h) => h.key === hostKey) ?? network?.hosts[0];
  const hostname = host?.host ?? window.location.hostname;
  const channels = useMemo(() => state?.channels ?? [], [state]);
  const channelFor = (k: string) => channels.find((c) => c.key === k) ?? null;

  // Plain HTTP when it answers on the chosen network -- most tools will not
  // take a self-signed certificate -- and the encrypted address, which rides
  // on the console and is always open, when it does not.
  const plain = endpoints.find((e) => e.key === 'api-http');
  const tls = endpoints.find((e) => e.key === 'api-https');
  const plainChannel = channelFor('api-http');
  const plainOpen = !!plain && (!state || !host || !plainChannel || reaches(plainChannel, host));
  const api = plainOpen ? plain : tls;
  const origin = api ? `${api.scheme}://${hostname}:${api.port}` : `http://${hostname}:8000`;
  const base = `${origin}/v1`;

  // Whatever is loaded, because that is what a request sent now would reach;
  // then the last one used; the first entry is an accident of config order.
  const model = models.find((m) => m.id === modelId)
    ?? models.find((m) => m.running)
    ?? models.find((m) => m.id === lastUsed)
    ?? models[0] ?? null;
  const ctx = model?.slots?.[0]?.n_ctx ?? model?.ctx_size ?? null;

  const snippets = snippetsFor({ base, origin, model, apiKey: key?.secret ?? null }, os);
  const active = snippets.find((s) => s.key === tool) ?? snippets[0];

  const openKey = () => { setKeyName(''); setKeyOpen(true); };

  const createKey = async () => {
    const me = auth?.identity;
    if (!me || !keyName.trim()) return;
    setCreating(true);
    try {
      const made = await createApiKey(me.user_id, keyName.trim());
      setKey({ name: keyName.trim(), secret: made.secret });
      setKeyOpen(false);
      message.success('已建立金鑰');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const run = async (channelKey: string, action: () => Promise<{ changed: boolean } & ChannelState>,
                     done: string) => {
    setBusy(channelKey);
    try {
      setState(await action());
      message.success(done);
    } catch (error) {
      message.error((error as Error).message);
      loadChannels();
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
    // reload interrupts connections briefly, so it earns a sentence.
    modal.confirm({
      title: `關閉 ${channel.label}？`,
      content: `連到 ${channel.ports.map((p) => `:${p}`).join('、')} 的工具會立刻斷線。`,
      okText: '關閉',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => run(channel.key, () => setChannel(channel.key, false), `${channel.label} 已關閉`),
    });
  };

  const setScopes = (channel: Channel, scopes: string[]) =>
    run(channel.key, () => setChannelScopes(channel.key, scopes), '已套用');

  const setReach = (channel: Channel, reach: string) => {
    if (reach === 'all') return setScopes(channel, ['wan']);
    if (reach === 'local') return setScopes(channel, []);
    // Entering 指定網路 from either end starts with the LAN: a reach of nothing
    // is what 只有這台 already means.
    const kept = channel.scopes.filter((s) => s !== 'wan');
    return setScopes(channel, kept.length ? kept : ['lan']);
  };

  const urlOn = (endpoint: Endpoint, h: string, port = endpoint.port) =>
    `${endpoint.scheme}://${h}:${port}${endpoint.path === '/' ? '' : endpoint.path}`;

  /** A value to copy, in a box of the same shape as the selects beside it. */
  const field = (value: string, label: string) => (
    <Space.Compact style={{ width: '100%' }}>
      <Input readOnly value={value} style={{ fontFamily: MONO, fontSize: 12 }}
             onFocus={(e) => e.currentTarget.select()} />
      <Tooltip title={`複製${label}`}>
        <Button icon={<CopyOutlined />} aria-label={`複製${label}`} onClick={() => copy(value)} />
      </Tooltip>
    </Space.Compact>
  );

  const address = (url: string) => (
    <Space size={4} style={{ maxWidth: '100%' }}>
      <Text style={{ fontFamily: MONO, fontSize: 12, overflowWrap: 'anywhere' }}>{url}</Text>
      <Tooltip title="複製">
        <Button size="small" type="text" icon={<CopyOutlined />} aria-label="複製" onClick={() => copy(url)} />
      </Tooltip>
    </Space>
  );

  /** Who may reach a channel, in words; the administrator may change it. */
  const reachRow = (channel: Channel) => {
    const reach = reachOf(channel);
    const note = !channel.enabled
      ? '關著，誰都連不到'
      : reach === 'local' ? '只有這台電腦自己' : reach === 'all' ? '這台機器的每個網路都能連' : '只有勾選的網路能連';
    if (!owner) return <Row label="誰能連" note={note} />;
    return (
      <Row label="誰能連" note={note}>
        <Space direction="vertical" size={8}>
          <Segmented size="small" value={reach} options={REACH}
                     disabled={!channel.enabled || busy !== null}
                     onChange={(v) => setReach(channel, String(v))} />
          {reach === 'pick' && (
            <Checkbox.Group value={channel.scopes} disabled={busy !== null}
                            onChange={(v) => setScopes(channel, v as string[])}>
              <Space size={14} wrap>
                {NETWORKS.map((n) => {
                  const at = state?.addresses?.[n.key as 'lan' | 'tailscale'];
                  return (
                    <Tooltip key={n.key} title={at ? `${n.hint}（${at}）` : '這台機器上沒有這個網路'}>
                      <Checkbox value={n.key} disabled={!at}>{n.label}</Checkbox>
                    </Tooltip>
                  );
                })}
              </Space>
            </Checkbox.Group>
          )}
        </Space>
      </Row>
    );
  };

  /** One way in, as a column of the bottom card: its name, switch and rows. */
  const way = (title: string, info: string, right: React.ReactNode, rows: React.ReactNode) => (
    <div style={{ borderLeft: `1px solid ${LINE.faint}`, borderTop: `1px solid ${LINE.faint}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 4px' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
        <Tooltip title={info} styles={{ root: { maxWidth: 360 } }}>
          <InfoCircleOutlined style={{ fontSize: 12, opacity: 0.45, cursor: 'help' }} />
        </Tooltip>
        <span style={{ marginInlineStart: 'auto' }}>{right}</span>
      </div>
      <div className="settings-box">{rows}</div>
    </div>
  );

  const channelSwitch = (channel: Channel | null) => channel && (
    <Space size={8}>
      {!channel.present && <Tag color="error" style={{ marginInlineEnd: 0 }}>設定檔遺失</Tag>}
      {owner ? (
        <Tooltip title={channel.enabled ? '開著' : '關著'}>
          <Switch size="small" checked={channel.enabled} loading={busy === channel.key}
                  disabled={!channel.present || busy !== null}
                  onChange={(next) => toggle(channel, next)} />
        </Tooltip>
      ) : (
        <Tag style={{ marginInlineEnd: 0 }}>{channel.enabled ? '開著' : '關著'}</Tag>
      )}
    </Space>
  );

  const console_ = endpoints.find((e) => e.key === 'console');
  const comfy = endpoints.find((e) => e.key === 'comfyui');
  const comfyChannel = channelFor('comfyui');
  const hosts = network?.hosts ?? [];

  const left = (
    <Card size="small" title="連到這台的模型" style={{ height: '100%' }} styles={{ body: { padding: 0 } }}>
      <div className="settings-box">
        <Fact title="你的工具在" note={host?.note}>
          <Select style={{ width: '100%' }} value={host?.key} onChange={setHostKey}
                  options={hosts.map((h) => ({ value: h.key, label: h.label }))} />
        </Fact>

        <Fact
          title="API 位址"
          info={<>OpenAI 格式是 {base}/chat/completions，Anthropic 格式是 {origin}/v1/messages，兩種都能用。</>}
          note={plainOpen
            ? '大部分工具的 base URL 填這個'
            : <><WarningFilled style={{ color: ACCENT.warn }} /> 純 HTTP 的 API 沒對這個網路開放，改給加密的位址；有些工具不接受這台的自簽憑證{owner ? '，可以在下面「連線方式」打開' : ''}。</>}
        >
          {field(base, 'API 位址')}
        </Fact>

        <Fact
          title="API 金鑰"
          info="每把金鑰屬於一個帳號。建議每個工具各用一把，不用了就在「使用者」頁刪掉那一把。"
          extra={auth?.enforcement && <Link to="/users" style={{ fontSize: 12 }}>管理金鑰</Link>}
          note={!auth?.enforcement
            ? '還沒有任何帳號，API 目前不檢查金鑰，隨便填一個值即可。'
            : key
              ? `「${key.name}」只會顯示這一次，離開這頁就看不到了；右邊的步驟已經帶入。`
              : '金鑰只會顯示一次，建立後右邊的步驟會自動帶入。'}
        >
          {!auth?.enforcement ? (
            <Input disabled value="不需要金鑰" />
          ) : key ? (
            field(key.secret, '金鑰')
          ) : (
            <Button block type="primary" icon={<KeyOutlined />} onClick={openKey}>建立金鑰</Button>
          )}
        </Fact>

        <Fact
          title="模型名稱"
          note={model
            ? `${model.running ? '執行中' : '還沒載入，第一次請求時會自動載入'}${ctx ? `・上下文 ${ctx.toLocaleString()} token` : ''}`
            : '還沒有設定任何模型'}
        >
          <Space.Compact style={{ width: '100%' }}>
            <Select style={{ flex: 1, minWidth: 0 }} value={model?.id} onChange={setModelId}
                    options={models.map((m) => ({ value: m.id, label: m.name || m.id }))}
                    showSearch optionFilterProp="label" />
            <Tooltip title="複製模型名稱">
              <Button icon={<CopyOutlined />} aria-label="複製模型名稱" disabled={!model}
                      onClick={() => model && copy(model.id)} />
            </Tooltip>
          </Space.Compact>
        </Fact>

        <div style={{ paddingBottom: 6 }}>
          <div style={{ padding: '14px 16px 4px' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>設定你的工具</div>
            <Text type="secondary" style={{ fontSize: 12 }}>選一個工具，右邊會列出步驟</Text>
          </div>
          {snippets.map((s, i) => {
            const on = s.key === active.key;
            const group = i === 0 || snippets[i - 1].group !== s.group;
            return (
              <div key={s.key}>
              {group && (
                <div style={{ padding: '10px 16px 4px', fontSize: 12, opacity: 0.5 }}>
                  {s.group === 'agent' ? '編碼代理' : '自己寫程式'}
                </div>
              )}
              <button
                type="button"
                className="tool-row"
                aria-pressed={on}
                onClick={() => setTool(s.key)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '10px 16px', border: 0, cursor: 'pointer', color: 'inherit', font: 'inherit',
                  background: on ? 'rgba(255,255,255,0.07)' : undefined,
                  boxShadow: on ? `inset 2px 0 0 ${ACCENT.warn}` : undefined,
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: on ? 600 : 400 }}>{s.label}</span>
                  <Text type="secondary" style={{ fontSize: 12 }}>{s.blurb}</Text>
                </span>
                <RightOutlined style={{ fontSize: 10, opacity: on ? 0.8 : 0.3 }} />
              </button>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );

  const right = (
    <Card
      size="small"
      title={`設定 ${active.label}`}
      style={{ height: '100%' }}
      styles={{ body: { padding: 16 } }}
      extra={(
        // The machine first, because every command is different on each one.
        // Detected, and still a control: someone reading this on a laptop is
        // often setting up the desktop beside it.
        <Segmented size="small" value={os} onChange={(v) => setOs(v as Os)}
                   options={[
                     { label: 'macOS', value: 'mac' },
                     { label: 'Linux', value: 'linux' },
                     { label: 'Windows', value: 'windows' },
                   ]} />
      )}
    >
      <ToolSteps snippet={active} apiKey={key?.secret ?? null}
                 onCreateKey={auth?.enforcement ? openKey : undefined} />
    </Card>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24 }}>
      <div style={{
        display: 'grid', gap: 16, alignItems: 'stretch',
        gridTemplateColumns: wide ? 'minmax(320px, 380px) minmax(0, 1fr)' : 'minmax(0, 1fr)',
      }}>
        {left}
        {right}
      </div>

      <Card
        size="small"
        title="連線方式"
        extra={(
          <Space size={10}>
            {host && <Text type="secondary" style={{ fontSize: 12 }}>API 與 ComfyUI 的位址以「{host.label}」顯示</Text>}
            <Tooltip title="「所有網路」是這台機器的所有網路介面；要從外面的網路連進來，還得在路由器上轉發埠號。"
                     styles={{ root: { maxWidth: 360 } }}>
              <InfoCircleOutlined style={{ opacity: 0.45, cursor: 'help' }} />
            </Tooltip>
          </Space>
        )}
        styles={{ body: { padding: 0, overflow: 'hidden' } }}
      >
        {/* Each column draws its left and top hairline; the negative margin
            tucks the ones on the outer edge under the card's own border, so
            the lines fall only between columns, however they wrap. */}
        <div style={{
          display: 'grid', margin: '-1px 0 0 -1px',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
        }}>
          {console_ && way(
            '主控台',
            '在瀏覽器打開。它一直開著，這頁關不掉，免得關掉正在用的這個畫面。第一次打開要接受這台的自簽憑證。',
            <Tag style={{ marginInlineEnd: 0 }}>一直開著</Tag>,
            hosts.map((h) => <Row key={h.key} label={h.label} note={address(urlOn(console_, h.host))} />),
          )}
          {plainChannel && way(
            'API',
            '這個開關管純 HTTP 的 API。加密的 API 跟主控台一起開著，不受它影響。',
            channelSwitch(plainChannel),
            <>
              {reachRow(plainChannel)}
              {plain && <Row label="純 HTTP" note={address(urlOn(plain, hostname))} />}
              {tls && <Row label="加密（跟主控台一起開著）" note={address(urlOn(tls, hostname))} />}
            </>,
          )}
          {comfyChannel && comfy && way(
            'ComfyUI',
            '生圖的原生介面，要先登入主控台才能用。',
            channelSwitch(comfyChannel),
            <>
              {reachRow(comfyChannel)}
              {(comfyChannel.ports.length ? comfyChannel.ports : [comfy.port]).map((port) => (
                <Row key={port} label="位址" note={address(urlOn(comfy, hostname, port))} />
              ))}
            </>,
          )}
        </div>
      </Card>

      <Modal
        title="建立 API 金鑰"
        open={keyOpen}
        okText="建立"
        cancelText="取消"
        confirmLoading={creating}
        okButtonProps={{ disabled: !keyName.trim() }}
        onOk={() => void createKey()}
        onCancel={() => setKeyOpen(false)}
      >
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
          取一個認得出來的名字，例如工具或電腦的名字；之後要停用哪一把就看這個。
        </Text>
        <Input
          autoFocus
          placeholder="例如：筆電的 Claude Code"
          value={keyName}
          onChange={(e) => setKeyName(e.target.value)}
          onPressEnter={() => void createKey()}
        />
      </Modal>
    </div>
  );
}
