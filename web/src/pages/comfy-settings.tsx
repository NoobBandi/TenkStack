/**
 * Everything the container is, in one block.
 *
 * Kept apart from what the instance is *doing*, which is the left-hand side.
 * These are the two questions an operator has and they do not interleave: one
 * is answered by pressing something and watching, the other by editing a form
 * and rebuilding.
 *
 * Cards are a list rather than a row of checkboxes. Two cards fit either way;
 * a list is what still reads when a machine has four, and it gives each card
 * room to say which one is doing the work.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Input, Popconfirm, Segmented, Select,
  Space, Tag, Typography,
} from 'antd';
import {
  fetchComfyConfig, saveComfyConfig,
  type ComfyConfig, type ComfyInstance,
} from '../api';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * The launch arguments the console writes for itself.
 *
 * Which cards a container has is the render nodes passed to `docker run`, and
 * that is already the selection: with one node passed the container sees one
 * XPU and needs no flag at all, which is why CLI_ARGS has been empty here all
 * along and everything worked.
 *
 * What the passthrough cannot say is which of two passed cards ComfyUI should
 * run on. That is `--default-device`, whose own help says the others stay
 * visible, so the second card remains available to a node that wants to place
 * something on it.
 *
 * Anything else goes in the field, and the two are joined on the way out. On
 * the way back in the generated part is stripped off again, so the field holds
 * what its owner put there and editing twice does not accumulate flags.
 */
const GENERATED = /--default-device\s+\S+/g;

export function splitArgs(cli: string): { device: number; extra: string } {
  const found = /--default-device\s+(\d+)/.exec(cli);
  return {
    device: found ? Number(found[1]) : 0,
    extra: cli.replace(GENERATED, '').replace(/[ \t]+/g, ' ').trim(),
  };
}

export function joinArgs(device: number, extra: string, cardCount: number): string {
  const generated = device > 0 && cardCount > 1 ? `--default-device ${device}` : '';
  // Newlines are how a long argument list stays readable in the box; the
  // container wants one line.
  return [generated, extra.replace(/\s+/g, ' ').trim()].filter(Boolean).join(' ');
}

export default function ContainerSettings({ instance, onDone }: {
  instance: ComfyInstance;
  onDone: () => void;
}) {
  const { message } = AntApp.useApp();
  const [config, setConfig] = useState<ComfyConfig | null>(null);
  const [dual, setDual] = useState(false);
  /** The card that does the work: the only one in single, the default in dual. */
  const [primary, setPrimary] = useState('');
  const [port, setPort] = useState<number | null>(null);
  const [extra, setExtra] = useState('');
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const found = await fetchComfyConfig(instance.port);
      const held = found.cards.filter((c) => c.held);
      const parts = splitArgs(found.cli_args);
      setConfig(found);
      setDual(held.length > 1);
      setPrimary(held[Math.min(parts.device, Math.max(held.length - 1, 0))]
        ?.pci_bdf_address ?? '');
      setPort(found.port);
      setExtra(parts.extra);
    } catch {
      // A container the console cannot inspect is not one it should offer to
      // rebuild.
      setConfig(null);
    }
  }, [instance.port]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  if (!config) return null;

  const addresses = config.cards.map((c) => c.pci_bdf_address ?? '').filter(Boolean);
  // Card order, not tick order: the backend passes the render nodes in the
  // order the cards come in, so `--default-device N` counts the same way.
  const chosen = dual ? addresses : [primary].filter(Boolean);
  const device = Math.max(chosen.indexOf(primary), 0);
  const composed = joinArgs(device, extra, chosen.length);

  const held = config.cards.filter((c) => c.held).map((c) => c.pci_bdf_address ?? '');
  const changed = composed !== config.cli_args
    || port !== config.port
    || chosen.length !== held.length
    || chosen.some((a) => !held.includes(a));

  const save = async () => {
    setSaving(true);
    try {
      await saveComfyConfig(config.name, chosen, composed, port ?? undefined);
      message.success('容器已重建');
      await loadConfig();
      onDone();
    } catch (error) {
      message.error(`重建失敗：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      size="small"
      title={<span style={{ fontSize: 12, opacity: 0.75 }}>容器設定</span>}
      extra={<Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
        {config.name}
      </Text>}
    >
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <div>
          <Text style={{ fontSize: 13 }}>顯示卡</Text>
          <div style={{ marginTop: 8 }}>
            <Segmented
              size="small"
              value={dual ? 'dual' : 'single'}
              onChange={(v) => {
                const next = v === 'dual';
                setDual(next);
                // Leaving dual, the primary is the one that was doing the work,
                // so it is the one to keep.
                if (!next && !primary) setPrimary(addresses[0] ?? '');
              }}
              options={[
                { value: 'single', label: '單卡' },
                { value: 'dual', label: `${addresses.length} 張卡`,
                  disabled: addresses.length < 2 },
              ]}
            />
          </div>

          {/* A list, one row per card, each saying whether it is in and whether
              it is the one doing the work. */}
          <div style={{ marginTop: 10, border: `1px solid ${LINE.faint}`, borderRadius: 6 }}>
            {config.cards.map((card, i) => {
              const address = card.pci_bdf_address ?? '';
              const included = chosen.includes(address);
              const isPrimary = address === primary && included;
              return (
                <div
                  key={address || i}
                  role="button"
                  tabIndex={0}
                  onClick={() => setPrimary(address)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setPrimary(address); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 12px', cursor: 'pointer',
                    borderTop: i === 0 ? 'none' : `1px solid ${LINE.faint}`,
                    background: isPrimary ? 'rgba(255,255,255,0.04)' : undefined,
                    opacity: included ? 1 : 0.4,
                  }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flex: 'none',
                    background: isPrimary ? ACCENT.ok
                      : included ? LINE.medium : 'transparent',
                    border: included ? 'none' : `1px solid ${LINE.soft}`,
                  }} />
                  <Text style={{ fontSize: 13, flex: 'none' }}>卡 {i}</Text>
                  <Text type="secondary" style={{
                    fontSize: 11, flex: '1 1 auto', minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {card.name}
                  </Text>
                  {isPrimary && (
                    <Tag color="green" style={{ marginInlineEnd: 0, fontSize: 10 }}>主要</Tag>
                  )}
                </div>
              );
            })}
          </div>

          {/* Not a disclaimer -- the thing worth knowing before spending twenty
              minutes here. Only once a second card is actually in. */}
          {chosen.length > 1 && (
            <Alert
              style={{ marginTop: 10 }}
              type="info"
              message={
                <Text style={{ fontSize: 12 }}>
                  ComfyUI 一次只會在主要那張卡上算圖。另一張要靠 MultiGPU 節點
                  才用得到，重建時會自動裝進容器裡；之後在工作流程裡用它的
                  Loader 節點指定哪個部分放哪張卡。
                </Text>
              }
            />
          )}
        </div>

        <div>
          <Text style={{ fontSize: 13 }}>對外連接埠</Text>
          <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Select
              size="small"
              value={port ?? undefined}
              onChange={setPort}
              style={{ width: 110 }}
              options={config.ports.map((p) => ({ value: p, label: String(p) }))}
            />
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              → 對外 {port === null ? '—' : 8444 + (port - 8188)}
            </Text>
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            這是容器在本機上的連接埠，對外的那個由它推算。只有這幾個號碼，
            因為主控台就是在這個範圍裡尋找實例的。
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 13 }}>額外參數</Text>
          <Input.TextArea
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={'一行一個或全部寫一行都可以，例如\n--reserve-vram 2\n--highvram'}
            style={{ marginTop: 8, fontFamily: MONO, fontSize: 12 }}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            選哪張卡不用寫在這裡，主控台會自己加。
          </Text>
        </div>

        <div>
          {/* What the container will actually receive. The console writes part
              of it, so it says which part rather than leaving someone to guess
              what the list above did. */}
          <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
            CLI_ARGS = {composed || '（空的，用預設）'}
          </Text>
          <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Popconfirm
              title="重建這個容器？"
              description="容器本身會被換掉。輸出目錄與設定檔留在磁碟上。"
              okText="重建" cancelText="取消"
              disabled={!changed || !chosen.length}
              onConfirm={() => void save()}
            >
              <Button type="primary" loading={saving} disabled={!changed || !chosen.length}>
                套用並重建
              </Button>
            </Popconfirm>
            {changed
              ? <Button onClick={() => void loadConfig()}>還原</Button>
              : <Text type="secondary" style={{ fontSize: 12 }}>目前沒有變更</Text>}
          </div>
        </div>
      </Space>
    </Card>
  );
}
