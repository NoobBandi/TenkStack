/**
 * The container card: one object, read as a list of rows.
 *
 * Each row is one thing that is true of the container, with whatever changes
 * that thing sitting on the same row -- the image beside the button that
 * replaces it, the version beside the button that updates it, the cards and
 * port and flags beside the controls that edit them. Actions and settings
 * used to be two columns, which left one of them short and the other tall
 * and said nothing about which button touched which fact. A row does.
 *
 * The rows exist from the first paint. What needs a second request -- the
 * image, the cards, the flags -- fills in when it arrives, so the card never
 * appears a beat after the ones above it.
 *
 * Cards are a list rather than a row of checkboxes. Two cards fit either way;
 * a list is what still reads when a machine has four, and it gives each card
 * room to say which one is doing the work.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Alert, App as AntApp, Button, Card, InputNumber, Popconfirm, Segmented, Space,
  Tag, Tooltip, Typography,
} from 'antd';
import {
  CloudDownloadOutlined, DeleteOutlined, PoweroffOutlined, ReloadOutlined,
} from '@ant-design/icons';
import {
  checkComfyVersion, comfyAction, controlContainer, fetchComfyConfig,
  restartComfy, saveComfyConfig, updateComfy,
  type ComfyConfig, type ComfyInstance,
} from '../api';
import { ACCENT, LINE, MONO } from '../theme';
import FlagPicker from '../components/FlagPicker';

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

/** system_stats says "0.36.0"; the release list says "v0.36.0". */
const tagged = (v: unknown) => (typeof v === 'string' && v ? 'v' + v.replace(/^v/, '') : null);

function ago(seconds: number | null): string {
  if (seconds === null) return '';
  const m = Math.round((Date.now() / 1000 - seconds) / 60);
  return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : `${Math.round(m / 60)} 小時前`;
}

/**
 * One row: the name of a thing, the thing, and what acts on it.
 *
 * The action column is fixed at the button width so the buttons line up
 * down the card whether or not a row has one, and the note sits under the
 * value where it explains the value, not under the button where it would
 * explain the button.
 */
function Row({ label, children, note, action }: {
  label: string;
  children: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', gap: 16, alignItems: 'flex-start',
      padding: '12px 0', borderTop: `1px solid ${LINE.faint}`,
    }}>
      <Text type="secondary" style={{
        fontSize: 11, letterSpacing: 1, width: 64, flex: 'none', paddingTop: 4,
      }}>
        {label}
      </Text>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        {children}
        {note && (
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
            {note}
          </Text>
        )}
      </div>
      {/* Centred on the row rather than on its first line: a value with a
          note under it is two lines tall, and a button hugging the top of
          that reads as belonging to the value alone. */}
      {action && <div style={{ flex: 'none', alignSelf: 'center' }}>{action}</div>}
    </div>
  );
}

export default function ContainerCard({ instance, staleAfterUpdate, onChanged, onRestarted }: {
  instance: ComfyInstance;
  /** True once an update has finished here but the process still runs the old
   *  code, so the version row can say what is left to do. */
  staleAfterUpdate: boolean;
  onChanged: () => void;
  onRestarted: () => void;
}) {
  const { message } = AntApp.useApp();
  const [config, setConfig] = useState<ComfyConfig | null>(null);
  const [dual, setDual] = useState(false);
  /** The card that does the work: the only one in single, the default in dual. */
  const [primary, setPrimary] = useState('');
  const [port, setPort] = useState<number | null>(null);
  const [extra, setExtra] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);

  const name = instance.container ?? config?.name ?? null;
  const busy = instance.queue_running > 0;
  const manager = instance.manager;
  const updating = manager?.processing ?? false;

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
      // rebuild; the rows stay, with nothing in them to edit.
      setConfig(null);
    }
  }, [instance.port]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  /** `done` is optional: an action that reports its own result says it once. */
  const run = async (label: string, action: () => Promise<unknown>, done?: string) => {
    setWorking(true);
    try {
      await action();
      if (done) message.success(done);
      onChanged();
    } catch (error) {
      message.error(`${label}失敗：${(error as Error).message}`);
    } finally {
      setWorking(false);
    }
  };

  // One call to ComfyUI's own repository. The button this replaced asked
  // Manager to git-fetch every installed node -- forty round trips to GitHub
  // and three minutes -- to answer a question 更新節點 answers on its way
  // through anyway, since it fetches exactly the same forty before pulling.
  const onCheck = async () => {
    setChecking(true);
    try {
      const found = await checkComfyVersion(instance.port);
      message.open({
        type: found.available ? 'info' : 'success',
        content: found.available ? `有新版 ${found.latest}` : '已是最新',
      });
      onChanged();
    } catch (error) {
      message.error(`查版本失敗：${(error as Error).message}`);
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await saveComfyConfig(config.name, chosen, composed, port ?? undefined);
      message.success('容器已重建');
      await loadConfig();
      onChanged();
    } catch (error) {
      message.error(`重建失敗：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const addresses = (config?.cards ?? []).map((c) => c.pci_bdf_address ?? '').filter(Boolean);
  // Card order, not tick order: the backend passes the render nodes in the
  // order the cards come in, so `--default-device N` counts the same way.
  const chosen = dual ? addresses : [primary].filter(Boolean);
  const device = Math.max(chosen.indexOf(primary), 0);
  const composed = joinArgs(device, extra, chosen.length);

  const held = (config?.cards ?? []).filter((c) => c.held).map((c) => c.pci_bdf_address ?? '');
  const changed = !!config && (
    composed !== config.cli_args
    || port !== config.port
    || chosen.length !== held.length
    || chosen.some((a) => !held.includes(a)));

  const current = tagged(instance.version);
  const latest = instance.latest;
  const behind = !!current && !!latest && current !== latest;

  const mono = { fontSize: 12, fontFamily: MONO } as const;

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          <span style={{ fontSize: 12, opacity: 0.75 }}>容器</span>
          <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>{name ?? ''}</Text>
        </Space>
      }
      styles={{ body: { paddingTop: 0 } }}
    >
      {/* The first row has no rule above it: the card header already draws
          that line. */}
      <div style={{ marginTop: -1 }}>
        <Row
          label="映像"
          note="下載新的 docker 映像重建容器，換掉整個執行環境；設定、output 與模型都留著"
          action={
            <Button size="small" icon={<CloudDownloadOutlined />}
                    loading={working} disabled={updating || !name}
                    onClick={() => void run('更新映像', () => comfyAction(name!, 'update'), '已開始下載新映像並重建')}>
              更新映像
            </Button>
          }
        >
          <Text style={mono}>
            {config ? config.image : <span style={{ opacity: 0.4 }}>讀取中…</span>}
            {config?.image_size ? <span style={{ opacity: 0.5 }}> ・ {config.image_size}</span> : ''}
          </Text>
        </Row>

        <Row
          label="ComfyUI"
          note={manager
            ? '透過 ComfyUI-Manager 更新 ComfyUI 本體與所有自訂節點，完成後要重啟才生效'
            : '沒有 ComfyUI-Manager，主控台無法替它查版本或更新'}
          action={
            <Button size="small" icon={<CloudDownloadOutlined />}
                    loading={working || updating} disabled={updating || !manager}
                    onClick={() => void run('更新', () => updateComfy(instance.port), '已開始更新')}>
              更新節點
            </Button>
          }
        >
          <Space size={8} wrap>
            <Text style={mono}>
              {current ?? '—'}
              {instance.torch ? <span style={{ opacity: 0.5 }}> ・ torch {instance.torch}</span> : ''}
              {instance.python ? <span style={{ opacity: 0.5 }}> ・ Python {instance.python}</span> : ''}
            </Text>
            {updating && manager ? (
              <Tag color="blue" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                更新中 {manager.done}/{manager.total}
              </Tag>
            ) : staleAfterUpdate ? (
              // The files on disk changed; the running process did not. Saying
              // so is the point -- an update that silently needs a restart looks
              // like an update that did nothing.
              <Tag color="gold" style={{ fontSize: 11, marginInlineEnd: 0 }}>更新完成，待重啟</Tag>
            ) : behind ? (
              <Tag color="gold" style={{ fontSize: 11, marginInlineEnd: 0 }}>有新版 {latest}</Tag>
            ) : latest ? (
              <Text type="secondary" style={{ fontSize: 11 }}>已是最新</Text>
            ) : manager ? (
              <Text type="secondary" style={{ fontSize: 11 }}>還沒查過</Text>
            ) : null}
            {manager && (
              <Button type="link" size="small" loading={checking} onClick={() => void onCheck()}
                      style={{ padding: 0, height: 'auto', fontSize: 11 }}>
                {instance.latest_checked_at ? `再查（${ago(instance.latest_checked_at)}查過）` : '查一下'}
              </Button>
            )}
          </Space>
        </Row>

        <Row
          label="顯示卡"
          note={chosen.length > 1 ? (
            // Not a disclaimer -- the thing worth knowing before spending twenty
            // minutes here. Only once a second card is actually in.
            <Alert
              style={{ marginTop: 4 }}
              type="info"
              message={
                <Text style={{ fontSize: 12 }}>
                  ComfyUI 一次只會在主要那張卡上算圖。另一張要靠 MultiGPU 節點
                  才用得到，重建時會自動裝進容器裡；之後在工作流程裡用它的
                  Loader 節點指定哪個部分放哪張卡。
                </Text>
              }
            />
          ) : undefined}
        >
          {config ? (
            <>
              <Segmented
                size="small"
                value={dual ? 'dual' : 'single'}
                onChange={(v) => {
                  const next = v === 'dual';
                  setDual(next);
                  // Leaving dual, the primary is the one that was doing the
                  // work, so it is the one to keep.
                  if (!next && !primary) setPrimary(addresses[0] ?? '');
                }}
                options={[
                  { value: 'single', label: '單卡' },
                  { value: 'dual', label: `${addresses.length} 張卡`, disabled: addresses.length < 2 },
                ]}
              />
              {/* A list, one row per card, each saying whether it is in and
                  whether it is the one doing the work. */}
              <div style={{ marginTop: 8, border: `1px solid ${LINE.faint}`, borderRadius: 6 }}>
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
                        padding: '7px 12px', cursor: 'pointer',
                        borderTop: i === 0 ? 'none' : `1px solid ${LINE.faint}`,
                        background: isPrimary ? 'rgba(255,255,255,0.04)' : undefined,
                        opacity: included ? 1 : 0.4,
                      }}
                    >
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', flex: 'none',
                        background: isPrimary ? ACCENT.ok : included ? LINE.medium : 'transparent',
                        border: included ? 'none' : `1px solid ${LINE.soft}`,
                      }} />
                      <Text style={{ fontSize: 12, flex: 'none' }}>卡 {i}</Text>
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
            </>
          ) : (
            <Text style={{ ...mono, opacity: 0.4 }}>讀取中…</Text>
          )}
        </Row>

        <Row
          label="連接埠"
          note={
            <>
              容器在本機上的連接埠，對外的那個由它推算。
              {port !== null && config && !config.ports.includes(port) && (
                // Outside the convention the console still finds it, but only
                // by asking docker what this container publishes -- so a
                // container that is not running is one it cannot look up.
                ' 這個號碼在慣例的 ' + config.ports[0] + '-' + config.ports[config.ports.length - 1]
                + ' 之外，主控台會改用容器實際發佈的埠去找，容器停掉時就找不到。'
              )}
            </>
          }
        >
          <Space size={10}>
            <InputNumber size="small" value={port} disabled={!config}
                         onChange={(v) => setPort(v ?? null)} min={1024} max={65535}
                         style={{ width: 110 }} />
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              → 對外 {config
                ? (port === config.port ? (config.public_port ?? '—') : '重建後決定')
                : (instance.public_port ?? '—')}
            </Text>
          </Space>
        </Row>

        <Row
          label="額外參數"
          note={
            <>
              一行一個。顯示卡由上面的清單決定，不用寫在這裡。
              <span style={{ fontFamily: MONO }}> CLI_ARGS = {composed || '（空的，用預設）'}</span>
            </>
          }
        >
          {config ? (
            <FlagPicker
              source={{ kind: 'comfyui', container: config.name }}
              value={extra}
              onChange={setExtra}
              // Written by the console from the card list above; a typed copy
              // would fight it.
              reserved={['--default-device']}
              // One line to start: this container has run with an empty
              // field all along, and three empty rows were the tallest thing
              // on the card. It grows as flags are added.
              rows={1}
            />
          ) : (
            <Text style={{ ...mono, opacity: 0.4 }}>讀取中…</Text>
          )}
        </Row>

        {/* Two groups on the last row. Left, the rows above are applied
            with one rebuild. Right, the container as a whole: restart,
            stop, remove -- what each costs is asked on the click, since
            two of them are the kind of thing to be sure about. */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          padding: '12px 0 0', borderTop: `1px solid ${LINE.faint}`,
        }}>
          <Popconfirm
            title="重建這個容器？"
            description="容器本身會被換掉。輸出目錄與設定檔留在磁碟上。"
            okText="重建" cancelText="取消"
            disabled={!changed || !chosen.length}
            onConfirm={() => void save()}
          >
            <Button size="small" type="primary" ghost loading={saving} disabled={!changed || !chosen.length}>
              套用並重建
            </Button>
          </Popconfirm>
          {changed
            ? <Button size="small" onClick={() => void loadConfig()}>還原</Button>
            : <Text type="secondary" style={{ fontSize: 11 }}>{config ? '目前沒有變更' : ''}</Text>}

          <Space size={8} style={{ marginLeft: 'auto' }}>
            <Button size="small" icon={<ReloadOutlined />} danger={busy} loading={working}
                    onClick={() => void run('重啟', async () => { await restartComfy(instance.port); onRestarted(); }, '已送出重啟')}>
              重啟
            </Button>
            <Popconfirm
              // Stopping keeps the container, and `--restart unless-stopped`
              // means a container stopped by hand stays stopped across a
              // reboot. That is the difference from 移除, and the reason both
              // exist: one parks it, the other ends it.
              title={`停止 ${name ?? '這個容器'}？`}
              description="容器留著，之後可以再啟動；重開機也不會自己起來。"
              okText="停止" cancelText="取消"
              disabled={!name}
              onConfirm={() => void run('停止', () => controlContainer(name!, 'stop'), '已停止')}
            >
              <Button size="small" icon={<PoweroffOutlined />} disabled={!name} loading={working}>停止</Button>
            </Popconfirm>
            <Popconfirm
              title={`移除 ${name ?? '這個容器'}？`}
              description="容器會被刪掉。output、工作流程與設定都在磁碟上，不會跟著走。"
              okText="移除" cancelText="取消" okButtonProps={{ danger: true }}
              disabled={!name}
              onConfirm={() => void run('移除', () => comfyAction(name!, 'remove'), '已移除')}
            >
              <Tooltip title="刪掉容器本身；磁碟上的東西都留著">
                <Button size="small" danger icon={<DeleteOutlined />} disabled={!name} loading={working}>移除</Button>
              </Tooltip>
            </Popconfirm>
          </Space>
        </div>
      </div>
    </Card>
  );
}
