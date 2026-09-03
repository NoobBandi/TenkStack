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
  Alert, App as AntApp, Button, Card, InputNumber, Popconfirm, Segmented, Select,
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

/**
 * The arguments worth offering, taken from `main.py --help` in the image that
 * is actually running rather than from memory: it lists ninety-nine, and these
 * are the ones that decide anything on a machine sharing its cards with an LLM.
 *
 * A tag select rather than a plain list, so a flag that takes a value can be
 * edited after it is picked and a flag nobody thought to list can still be
 * typed. `--default-device` is deliberately absent and filtered out if typed:
 * the console writes that one from the card list, and two of them would fight.
 */
const ARGUMENT_GROUPS = [
  {
    label: '顯存',
    options: [
      { value: '--lowvram', label: '--lowvram　模型分段搬進顯存，省顯存但較慢' },
      { value: '--novram', label: '--novram　lowvram 還不夠時用' },
      { value: '--highvram', label: '--highvram　模型用完留在顯存裡，較快但佔著' },
      { value: '--gpu-only', label: '--gpu-only　連文字編碼器都留在顯存' },
      { value: '--reserve-vram 2', label: '--reserve-vram N　留 N GB 給別人，數字可改' },
      { value: '--disable-smart-memory', label: '--disable-smart-memory　用完就放掉，不留快取' },
      { value: '--cache-none', label: '--cache-none　不快取節點結果，最省記憶體' },
    ],
  },
  {
    label: '精度',
    options: [
      { value: '--bf16-unet', label: '--bf16-unet　擴散模型用 bf16' },
      { value: '--fp16-vae', label: '--fp16-vae　VAE 用 fp16，可能出現全黑的圖' },
      { value: '--fp32-vae', label: '--fp32-vae　VAE 用完整精度' },
      { value: '--cpu-vae', label: '--cpu-vae　VAE 放 CPU 跑，換顯存' },
      { value: '--force-fp16', label: '--force-fp16　強制 fp16' },
      { value: '--force-fp32', label: '--force-fp32　強制 fp32' },
    ],
  },
  {
    label: '速度',
    options: [
      { value: '--fast', label: '--fast　開啟未充分測試的加速，可能影響畫質' },
      { value: '--async-offload', label: '--async-offload　非同步搬運權重' },
      { value: '--use-pytorch-cross-attention', label: '--use-pytorch-cross-attention' },
      { value: '--use-sage-attention', label: '--use-sage-attention' },
      { value: '--disable-mmap', label: '--disable-mmap　載入 safetensors 不用 mmap' },
    ],
  },
  {
    label: '其他',
    options: [
      { value: '--preview-method none', label: '--preview-method none　關掉取樣預覽' },
      { value: '--disable-all-custom-nodes', label: '--disable-all-custom-nodes　只載本體，排錯用' },
      { value: '--disable-api-nodes', label: '--disable-api-nodes　關掉需要外部 API 的節點' },
    ],
  },
];

/**
 * Words to tags, keeping a flag and its value together.
 *
 * A flag followed by a word that does not itself start a flag is that flag's
 * value. That covers the listed ones and the ninety or so that are not listed:
 * split into separate chips, deleting the flag would leave its value behind as
 * a bare word the container would then choke on.
 */
function toTags(extra: string): string[] {
  const words = extra.split(/\s+/).filter(Boolean);
  const tags: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const next = words[i + 1];
    if (words[i].startsWith('-') && next && !next.startsWith('-')) {
      tags.push(`${words[i]} ${next}`);
      i += 1;
    } else {
      tags.push(words[i]);
    }
  }
  return tags;
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
            <InputNumber
              size="small"
              value={port}
              onChange={(v) => setPort(v ?? null)}
              min={1024}
              max={65535}
              style={{ width: 110 }}
            />
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              → 對外 {port === null ? '—' : 8444 + (port - 8188)}
            </Text>
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            這是容器在本機上的連接埠，對外的那個由它推算。
            {port !== null && !config.ports.includes(port) && (
              // Outside the convention the console still finds it, but only by
              // asking docker what this container publishes -- so a container
              // that is not running is one it cannot look up.
              ' 這個號碼在慣例的 ' + config.ports[0] + '-'
              + config.ports[config.ports.length - 1]
              + ' 之外，主控台會改用容器實際發佈的埠去找，容器停掉時就找不到。'
            )}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 13 }}>額外參數</Text>
          <Select
            mode="tags"
            value={toTags(extra)}
            onChange={(tags: string[]) => setExtra(
              // The console writes this one from the card list; a typed copy
              // would fight it.
              tags.filter((t) => !t.startsWith('--default-device')).join(' '))}
            options={ARGUMENT_GROUPS}
            placeholder="從清單挑，或直接打字"
            style={{ width: '100%', marginTop: 8 }}
            optionFilterProp="label"
            tokenSeparators={[',']}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            清單是這顆映像 --help 列出來的；沒列到的直接打進去也會照送。
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
