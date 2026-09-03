import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Checkbox, Dropdown, Input, Popconfirm,
  Space, Switch, Tag, Tooltip, Typography,
} from 'antd';
import {
  CloudDownloadOutlined, DeleteOutlined, DownOutlined, ExportOutlined,
  ReloadOutlined, SearchOutlined, StopOutlined, SyncOutlined,
} from '@ant-design/icons';
import {
  checkComfyUpdates, comfyAction, fetchComfyConfig, fetchComfyInstances,
  fetchRuntimes, interruptComfy, restartComfy, saveComfyConfig, setCardRole,
  updateComfy,
  type ComfyConfig, type ComfyInstance, type RuntimeCoverage,
} from '../api';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * Image generation.
 *
 * The console does not try to be ComfyUI. It answers four questions -- is it
 * up, on which card, is it busy, and take me to it -- and shows what came out.
 * Everything else is one click away in ComfyUI's own interface, which is a
 * whole canvas application and not something worth reproducing or embedding.
 *
 * The page is a list because the card an instance uses is fixed when it starts:
 * --oneapi-device-selector and its siblings are launch flags. Two cards
 * therefore means two instances, and choosing a card means choosing which
 * instance to open rather than setting anything. Today that list has one entry;
 * the shape is what keeps a second card from being a rewrite.
 */

/**
 * Where an instance is reachable from this browser.
 *
 * Only the port comes from the backend -- the host has to be the one already in
 * the address bar, so the link works both from this machine and from elsewhere
 * on the network. Over plain HTTP the console is being served by the Vite dev
 * server, which sits in front of nothing, so the loopback port is used directly.
 */
function instanceUrl(instance: ComfyInstance): string | null {
  if (window.location.protocol !== 'https:') {
    return `http://${window.location.hostname}:${instance.port}`;
  }
  if (instance.public_port === null) return null;
  return `https://${window.location.hostname}:${instance.public_port}`;
}

/** "xpu:0 Intel(R) Arc(TM) Pro B70 Graphics" -> ["xpu:0", "Arc Pro B70"]. */
function deviceLabel(instance: ComfyInstance): [string, string] | null {
  if (!instance.device?.name) return null;
  const [slot, ...rest] = instance.device.name.split(' ');
  const card = rest.join(' ')
    .replace(/\(R\)|\(TM\)|Graphics/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [slot, card || instance.device.type];
}

function Instance({ instance, onChanged, staleAfterUpdate, onRestarted }: {
  instance: ComfyInstance;
  onChanged: () => void;
  /** True once an update has finished here but the process still runs the old
   *  code, so the row can say what is left to do. */
  staleAfterUpdate: boolean;
  onRestarted: () => void;
}) {
  const { message } = AntApp.useApp();
  const [stopping, setStopping] = useState(false);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const url = instanceUrl(instance);
  const device = deviceLabel(instance);
  const busy = instance.queue_running > 0;
  const queued = instance.queue_pending;
  const manager = instance.manager;
  const updating = manager?.processing ?? false;

  /** `done` is optional: an action that reports its own result says it once. */
  const run = async (
    label: string,
    setBusy: (v: boolean) => void,
    action: () => Promise<unknown>,
    done?: string,
  ) => {
    setBusy(true);
    try {
      await action();
      if (done) message.success(done);
      onChanged();
    } catch (error) {
      message.error(`${label}失敗：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onInterrupt = () =>
    run('中斷', setStopping, () => interruptComfy(instance.port), '已送出中斷');

  const onCheck = () =>
    run('檢查更新', setChecking, async () => {
      // A git fetch against every installed node, so minutes rather than
      // seconds. Said up front, because a button that just spins reads as hung.
      message.loading({ content: '檢查中，四十個節點各要連一次 GitHub…', key: 'check', duration: 0 });
      try {
        const { available } = await checkComfyUpdates(instance.port);
        // The same channel either way: "nothing to do" is the answer people are
        // hoping for, not a failure.
        message.open({
          type: available ? 'info' : 'success',
          content: available ? '有可更新的項目' : '已是最新',
          key: 'check',
        });
      } catch (error) {
        // The loading toast has duration 0, so it has to be taken down by hand
        // or a failed check leaves it spinning forever.
        message.destroy('check');
        throw error;
      }
    });

  const onUpdate = () =>
    run('更新', setStarting, () => updateComfy(instance.port), '已開始更新');

  const onRestart = () =>
    run('重啟', setStarting, async () => {
      await restartComfy(instance.port);
      onRestarted();
    }, '已送出重啟');

  // Plain words for the state, because this is the line that decides whether
  // somebody who has never met ComfyUI tries to use it right now. "queue_running
  // 0 / pending 0" is the same fact and answers nobody.
  const state = updating ? { text: '更新中', tone: ACCENT.warn }
    : busy ? { text: '正在算圖', tone: ACCENT.ok }
      : { text: '可以使用', tone: ACCENT.ok };

  return (
    <Card size="small">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <Space size={8} align="center">
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flex: 'none',
              background: busy || !updating ? state.tone : LINE.strong,
            }} />
            <Text style={{ fontSize: 15 }}>{state.text}</Text>
            {updating && manager && (
              <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO }}>
                {manager.done}/{manager.total}
              </Text>
            )}
            {busy && queued > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>還有 {queued} 張排隊</Text>
            )}
            {instance.stale && (
              // ComfyUI is aiohttp over synchronous torch, so it answers nothing
              // while a sampling step runs. Saying the numbers are old beats
              // either alternative: presenting them as current, or dropping the
              // row and claiming the instance is not running.
              <Tooltip title="ComfyUI 正忙著算，暫時沒有回應。顯示的是最後一次拿到的數字。">
                <Tag color="blue" style={{ fontSize: 11 }}>數字為舊值</Tag>
              </Tooltip>
            )}
            {!updating && staleAfterUpdate && (
              // The files on disk changed; the running process did not. Saying
              // so is the point -- an update that silently needs a restart looks
              // like an update that did nothing.
              <Tag color="gold" style={{ fontSize: 11 }}>更新完成，待重啟</Tag>
            )}
          </Space>

          {/* One sentence for someone who has not used it. The page had none,
              and a bare version number does not tell anybody what this is. */}
          <div style={{ marginTop: 6 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              ComfyUI 是畫圖的工具，操作都在它自己的介面裡。畫好的圖會出現在下面。
            </Text>
          </div>

          {/* The technical facts, demoted. They matter when something is wrong
              and never before that, so they read as a footnote rather than as
              the headline they used to be. */}
          <Space size={10} style={{ marginTop: 8 }} wrap>
            {device && (
              <Tooltip title="ComfyUI 啟動時就綁定這張卡，換卡要改啟動參數">
                <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
                  {device[0]} {device[1]}
                </Text>
              </Tooltip>
            )}
            <Tooltip title={`PyTorch ${instance.torch ?? '?'} ・ Python ${instance.python}`}>
              <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
                v{instance.version}
              </Text>
            </Tooltip>
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              :{instance.port}
            </Text>
          </Space>
        </div>

        <Space size={8} style={{ marginLeft: 'auto', flex: 'none' }}>
          {/* Only while there is something to interrupt. A permanently greyed
              button beside the one that matters is noise. */}
          {busy && (
            <Button size="small" danger icon={<StopOutlined />}
                    loading={stopping} onClick={onInterrupt}>
              中斷
            </Button>
          )}

          {manager && (
            <Dropdown
              disabled={updating}
              menu={{
                items: [
                  {
                    key: 'check',
                    label: '檢查更新',
                    icon: <SearchOutlined />,
                    onClick: () => void onCheck(),
                  },
                  {
                    key: 'update',
                    label: '更新 ComfyUI 與節點',
                    icon: <CloudDownloadOutlined />,
                    onClick: () => void onUpdate(),
                  },
                  { type: 'divider' },
                  {
                    key: 'restart',
                    label: '重啟',
                    icon: <ReloadOutlined />,
                    danger: busy,
                    onClick: () => void onRestart(),
                  },
                ],
              }}
            >
              <Button size="small" loading={checking || starting || updating}>
                維護 <DownOutlined style={{ fontSize: 9 }} />
              </Button>
            </Dropdown>
          )}

          {/* The one thing anyone came here to do, and it was a small ghost
              button at the end of a row of equals. */}
          {url ? (
            <Button type="primary" icon={<ExportOutlined />}
                    href={url} target="_blank" rel="noreferrer">
              開啟 ComfyUI
            </Button>
          ) : (
            // Reachable on loopback but with no Caddy site block in front of it,
            // so there is no authenticated way in from a browser. A link that
            // cannot connect would be worse than saying why.
            <Tooltip title="需要在 caddy/channels 補上對應的站台設定，才有經過登入的入口">
              <Button disabled>尚未發佈</Button>
            </Tooltip>
          )}
        </Space>
      </div>
    </Card>
  );
}

/**
 * What the container is made of, as something that can be changed.
 *
 * The cards are a `docker run` argument. Nothing reads them back out of
 * ComfyUI, nothing changes them at runtime, and until now the only way to move
 * one was to delete the instance and make another -- which is also how you lose
 * a settings profile somebody spent an evening on. Changing them here replaces
 * the container and keeps everything else: the name, the port, the directories,
 * and the site block in front of it.
 *
 * The note about one card is not a disclaimer, it is the thing worth knowing
 * before spending twenty minutes on this. Two render nodes make two XPUs
 * visible to torch; ComfyUI still runs its graph on one of them. Splitting a
 * model across cards is a MultiGPU-style custom node's job -- it decides where
 * the UNet goes and where the text encoder goes -- and passing both cards in is
 * the prerequisite for that rather than a substitute for it.
 */
function Settings({ instance, onDone }: { instance: ComfyInstance; onDone: () => void }) {
  const { message } = AntApp.useApp();
  const [config, setConfig] = useState<ComfyConfig | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [args, setArgs] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await fetchComfyConfig(instance.port);
      setConfig(found);
      setChosen(found.cards.filter((c) => c.held)
        .map((c) => c.pci_bdf_address ?? '').filter(Boolean));
      setArgs(found.cli_args);
    } catch {
      // The panel simply does not appear. A container the console cannot
      // inspect is not one it should offer to rebuild.
      setConfig(null);
    }
  }, [instance.port]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      await saveComfyConfig(config.name, chosen, args);
      message.success('容器已重建');
      await load();
      onDone();
    } catch (error) {
      message.error(`重建失敗：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!config) return null;

  const held = config.cards.filter((c) => c.held).map((c) => c.pci_bdf_address ?? '');
  const changed = args !== config.cli_args
    || chosen.length !== held.length
    || chosen.some((a) => !held.includes(a));

  return (
    <Card size="small" title={<span style={{ fontSize: 12, opacity: 0.75 }}>容器設定</span>}
          extra={<Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
            {config.name}
          </Text>}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div>
          <Text style={{ fontSize: 13 }}>這個容器可以用哪幾張卡</Text>
          <div style={{ marginTop: 8 }}>
            <Checkbox.Group
              value={chosen}
              onChange={(v) => setChosen(v as string[])}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
              options={config.cards.map((card, i) => ({
                value: card.pci_bdf_address ?? '',
                label: (
                  <Space size={8}>
                    <Text style={{ fontSize: 13 }}>卡 {i}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{card.name}</Text>
                  </Space>
                ),
              }))}
            />
          </div>
          {/* Not a disclaimer -- the thing worth knowing before spending twenty
              minutes here. */}
          <Alert
            style={{ marginTop: 10 }}
            type="info"
            message={
              <Text style={{ fontSize: 12 }}>
                ComfyUI 一次只會在一張卡上算圖。給它兩張是為了讓 MultiGPU 類的節點
                能把模型的不同部分放到另一張卡上——那個節點還沒安裝，可以在
                ComfyUI Manager 裡裝。
              </Text>
            }
          />
        </div>

        <div>
          <Text style={{ fontSize: 13 }}>啟動參數</Text>
          <Input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="例如 --oneapi-device-selector level_zero:1"
            style={{ marginTop: 8, fontFamily: MONO, fontSize: 12 }}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            原樣傳給 ComfyUI 的 CLI_ARGS。留空就是預設。
          </Text>
        </div>

        <Space size={10}>
          <Popconfirm
            title="重建這個容器？"
            description="容器本身會被換掉。連接埠、輸出目錄、設定檔與登入入口都不變。"
            okText="重建" cancelText="取消"
            disabled={!changed || !chosen.length}
            onConfirm={() => void save()}
          >
            <Button type="primary" size="small" loading={saving}
                    disabled={!changed || !chosen.length}>
              重建容器
            </Button>
          </Popconfirm>
          {changed && (
            <Button size="small" onClick={() => void load()}>還原</Button>
          )}
          {!changed && (
            <Text type="secondary" style={{ fontSize: 12 }}>目前沒有變更</Text>
          )}
        </Space>
      </Space>
    </Card>
  );
}

/**
 * Which cards run ComfyUI, and the switch that changes it.
 *
 * This lived on the runtime page, one column in a table about GPUs in general.
 * That is where it belongs when the question is "what is this machine made of",
 * and the wrong place entirely when the question is "why is there only one
 * ComfyUI". A card is fixed at container start -- the device is a launch flag --
 * so the number of instances is the number of cards switched on here, and
 * nothing else sets it.
 *
 * Turning one on pulls an image of sixteen to twenty gigabytes and that runs in
 * the background, so the row reports the pull rather than pretending the click
 * finished the job.
 */
function Cards({ onChanged }: { onChanged: () => void }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<RuntimeCoverage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await fetchRuntimes());
    } catch {
      setRows((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    // Only while something is being pulled does this need to move; a card that
    // is not changing state answers the same thing every time.
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const toggle = async (row: RuntimeCoverage, on: boolean) => {
    const key = row.pci_bdf_address ?? row.comfy.slot;
    setBusy(key);
    try {
      await setCardRole(row.pci_bdf_address ?? '', 'images', on);
      message.success(on ? '開始建立，映像要下載一陣子' : '已移除');
      await load();
      onChanged();
    } catch (error) {
      message.error(`${on ? '建立' : '移除'}失敗：${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async (row: RuntimeCoverage) => {
    if (!row.comfy.container) return;
    const key = row.pci_bdf_address ?? row.comfy.slot;
    setBusy(key);
    try {
      await comfyAction(row.comfy.container, 'update');
      message.success('開始更新映像並重建容器');
      await load();
    } catch (error) {
      message.error(`更新失敗：${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  if (!rows) return null;

  return (
    <Card size="small" title={<span style={{ fontSize: 12, opacity: 0.75 }}>顯示卡</span>}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {rows.map((row) => {
          const key = row.pci_bdf_address ?? row.comfy.slot;
          const job = row.comfy.job;
          const running = !!row.comfy.container;
          const template = row.comfy.template;
          return (
            <div key={key} style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <Switch
                size="small"
                checked={running}
                loading={busy === key || (!!job && job.state !== 'done' && job.state !== 'error')}
                disabled={!template && !running}
                onChange={(on) => void toggle(row, on)}
              />
              <div style={{ minWidth: 0, flex: '1 1 220px' }}>
                <Text style={{ fontSize: 13 }}>{row.name ?? '不明的卡'}</Text>
                <div>
                  <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
                    {row.comfy.container ?? (template ? `未建立・會叫 comfyui-${row.comfy.slot}` : '沒有這家廠商的映像範本')}
                    {row.comfy.image_size ? ` ・ ${row.comfy.image_size}` : ''}
                  </Text>
                </div>
              </div>

              {job && job.state !== 'done' && (
                <Space size={6}>
                  <SyncOutlined spin={job.state !== 'error'}
                                style={{ fontSize: 12, opacity: 0.7 }} />
                  <Text style={{ fontSize: 12, fontFamily: MONO }}>
                    {job.state === 'pulling'
                      ? `下載中 ${job.layers_done}/${job.layers_total}`
                      : job.state === 'error' ? '失敗' : '啟動中'}
                  </Text>
                </Space>
              )}

              {running && (
                <Space size={6}>
                  <Tooltip title="拉新的映像並用它重建這個容器。輸出與設定檔都在容器外，不會跟著消失。">
                    <Button size="small" icon={<CloudDownloadOutlined />}
                            loading={busy === key} onClick={() => void rebuild(row)}>
                      更新映像
                    </Button>
                  </Tooltip>
                  <Popconfirm
                    title={`移除 comfyui-${row.comfy.slot}？`}
                    description="容器會被刪掉，output 與設定檔留在磁碟上。"
                    okText="移除" cancelText="取消" okButtonProps={{ danger: true }}
                    onConfirm={() => void toggle(row, false)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>移除</Button>
                  </Popconfirm>
                </Space>
              )}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

export default function ComfyUI() {
  const { message } = AntApp.useApp();
  const [instances, setInstances] = useState<ComfyInstance[] | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  /** Ports whose update queue was running and then stopped. Derived from the
   *  poll rather than from the click, so it survives a page reload and catches
   *  an update started from ComfyUI's own interface. */
  const [stale, setStale] = useState<Set<number>>(new Set());
  const wasUpdating = useRef<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    let found: ComfyInstance[] = [];
    try {
      found = await fetchComfyInstances();
    } catch {
      // Leave the last known list rather than blanking the page on one bad poll.
      setInstances((prev) => prev ?? []);
      return;
    }
    setInstances(found);

    const now = new Set(found.filter((i) => i.manager?.processing).map((i) => i.port));
    const finished = [...wasUpdating.current].filter((p) => !now.has(p));
    wasUpdating.current = now;
    if (finished.length) {
      setStale((prev) => new Set([...prev, ...finished]));
    }
    // An instance that restarted comes back with a fresh queue, so the version
    // on screen is the running one again and the flag has done its job.
    setStale((prev) => {
      const kept = [...prev].filter((p) => found.some((i) => i.port === p));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }, []);

  useEffect(() => {
    void refresh();
    // ComfyUI publishes no event stream to the console, so queue depth is the
    // one thing here that genuinely has to be polled.
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const many = (instances?.length ?? 0) > 1;
  // The whole point of the shared button: updating N instances is one action,
  // so per-instance state staying separate costs nothing in effort.
  const updatable = (instances ?? []).filter((i) => i.manager && !i.manager.processing);

  const onUpdateAll = async () => {
    setUpdatingAll(true);
    const failed: number[] = [];
    await Promise.all(updatable.map((i) =>
      updateComfy(i.port).catch(() => { failed.push(i.port); })));
    setUpdatingAll(false);
    // Named rather than counted: with two cards, "1 個失敗" does not say which
    // one still needs attention.
    if (failed.length) message.error(`這些沒能開始：${failed.map((p) => `:${p}`).join('、')}`);
    else message.success(`已對 ${updatable.length} 個實例開始更新`);
    void refresh();
  };

  return (
    // Two columns rather than a dialog. What the instance is doing and what the
    // container is made of are read together -- the second is the reason the
    // first says what it says -- and a dialog puts one of them behind the other.
    // They stack below 900px, where a 340px column would leave the left side
    // narrower than the buttons in it.
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <Space direction="vertical" size={16} style={{ flex: '1 1 460px', minWidth: 0 }}>
        {many && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            size="small" icon={<CloudDownloadOutlined />}
            loading={updatingAll} disabled={!updatable.length}
            onClick={() => void onUpdateAll()}
          >
            全部更新（{updatable.length}）
          </Button>
        </div>
      )}

        {instances !== null && instances.length === 0 && (
          // The instructions used to be a shell script to run by hand. The
          // switch below does the same thing, so pointing at the script would
          // be sending someone to a terminal for a button that is on screen.
          <Alert
            type="warning"
            showIcon
            message="沒有執行中的 ComfyUI"
            description={
              <span>
                在下面的顯示卡列表打開任一張卡的開關就會建立。映像約 20 GB，
                第一次要下載一陣子；建好之後容器會 <code>restart unless-stopped</code>，
                開機自動啟動。
              </span>
            }
          />
        )}

        {instances?.map((i) => (
          <Instance
            key={i.port}
            instance={i}
            onChanged={() => void refresh()}
            staleAfterUpdate={stale.has(i.port)}
            onRestarted={() => setStale((prev) => {
              const next = new Set(prev);
              next.delete(i.port);
              return next;
            })}
          />
        ))}

        <Cards onChanged={() => void refresh()} />
      </Space>

      <div style={{ flex: '1 1 340px', minWidth: 0, maxWidth: 460 }}>
        {instances?.[0] && (
          <Settings instance={instances[0]} onDone={() => void refresh()} />
        )}
      </div>

    </div>
  );
}
