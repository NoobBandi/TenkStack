import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert, App as AntApp, Button, Card, Dropdown, Empty, Image, Popconfirm, Space,
  Tag, Tooltip, Typography,
} from 'antd';
import {
  CloudDownloadOutlined, DownOutlined, ExportOutlined, FolderOpenOutlined,
  PoweroffOutlined, ReloadOutlined, SearchOutlined, StopOutlined,
} from '@ant-design/icons';
import {
  checkComfyUpdates, comfyImageUrl, fetchComfyHistory, fetchComfyInstances,
  interruptComfy, restartComfy, unloadAll, updateComfy,
  type ComfyHistoryItem, type ComfyInstance,
} from '../api';
import { useStream } from '../stream';
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
 * Whose memory ComfyUI is competing for.
 *
 * The one thing this console can say that ComfyUI cannot. Both live on the same
 * two cards, an LLM holds twenty-four gigabytes of each for as long as it stays
 * loaded, and nothing unloads it on a timer -- every model here is set to ttl 0.
 * So the first generation of the evening fails with a CUDA-shaped error message
 * inside somebody else's interface, and there is no way to tell from there that
 * the cause is a chat model somebody stopped using an hour ago.
 *
 * Said here instead, before it happens, with the button that fixes it.
 */
function Vram({ instance }: { instance: ComfyInstance | null }) {
  const { message } = AntApp.useApp();
  const { gpus, models } = useStream();
  const [freeing, setFreeing] = useState(false);

  // "xpu:0 Intel(R) Arc(TM) Pro B70" -> 0. ComfyUI is bound to one card at
  // launch, so only that card's headroom decides anything.
  const mine = Number(/^xpu:(\d+)/.exec(instance?.device?.name ?? '')?.[1] ?? NaN);
  const card = gpus.find((g) => g.index === mine) ?? gpus[0];
  const loaded = models.filter((m) => m.running);
  // A slot with tokens in it is a conversation somebody can come back to; a busy
  // one is a request being answered right now.
  const working = loaded.some((m) => m.slots?.some((s) => s.busy));
  const holding = loaded.some((m) => m.slots?.some((s) => s.used > 0));

  const free = card?.memory_total_mib && card?.memory_used_mib !== null
    ? (card.memory_total_mib - (card.memory_used_mib ?? 0)) / 1024 : null;

  const onFree = async () => {
    setFreeing(true);
    try {
      await unloadAll();
      message.success('已卸載，顯存騰出來了');
    } catch (error) {
      message.error(`卸載失敗：${(error as Error).message}`);
    } finally {
      setFreeing(false);
    }
  };

  if (!gpus.length) return null;

  return (
    <Card size="small" title={<span style={{ fontSize: 12, opacity: 0.75 }}>顯示卡記憶體</span>}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {gpus.map((gpu) => {
          const total = (gpu.memory_total_mib ?? 0) / 1024;
          const used = (gpu.memory_used_mib ?? 0) / 1024;
          const percent = total ? Math.min(100, (used / total) * 100) : 0;
          const isMine = gpu.index === card?.index;
          return (
            <div key={gpu.index} style={{
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <Text style={{
                fontSize: 12, fontFamily: MONO, width: 74, flex: 'none',
                opacity: isMine ? 1 : 0.5,
              }}>
                卡 {gpu.index}{isMine ? ' ・這張' : ''}
              </Text>
              <div style={{
                flex: 1, height: 6, borderRadius: 3, overflow: 'hidden',
                background: 'rgba(255,255,255,0.07)',
              }}>
                <div style={{
                  height: '100%', width: `${percent}%`, borderRadius: 3,
                  transition: 'width 300ms',
                  background: percent > 85 ? ACCENT.warn : 'rgba(255,255,255,0.6)',
                  opacity: isMine ? 1 : 0.4,
                }} />
              </div>
              <Text style={{
                fontSize: 12, fontFamily: MONO, width: 132, flex: 'none',
                textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                opacity: isMine ? 1 : 0.5,
              }}>
                剩 {(total - used).toFixed(1)} / {total.toFixed(1)} GB
              </Text>
            </div>
          );
        })}

        {loaded.length > 0 && (
          <Alert
            type={free !== null && free < 8 ? 'warning' : 'info'}
            showIcon
            message={
              <Text style={{ fontSize: 13 }}>
                {loaded.map((m) => m.name ?? m.id).join('、')} 正載入中，佔用顯存
              </Text>
            }
            description={
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {free !== null && free < 8
                    ? `這張卡只剩 ${free.toFixed(1)} GB，畫圖可能會失敗。`
                    : '目前還有空間，但大張的圖仍可能不夠用。'}
                  {working
                    ? '不過現在有請求正在跑，卸載會中斷對方。'
                    : holding
                      ? '目前沒有請求在跑，但對話快取還在，卸載後下次要重新讀入。'
                      : ''}
                </Text>
                <Popconfirm
                  title="卸載目前載入的模型？"
                  description={working
                    ? '現在有請求正在執行，卸載會直接中斷它。'
                    : '下一次聊天會重新載入，約需要一分鐘。'}
                  okText="卸載" cancelText="取消"
                  okButtonProps={{ danger: working }}
                  onConfirm={() => void onFree()}
                >
                  <Button size="small" color="orange" variant="filled"
                          icon={<PoweroffOutlined />} loading={freeing}>
                    卸載模型，騰出顯存
                  </Button>
                </Popconfirm>
              </Space>
            }
          />
        )}
      </Space>
    </Card>
  );
}

export default function ComfyUI() {
  const { message } = AntApp.useApp();
  const [instances, setInstances] = useState<ComfyInstance[] | null>(null);
  const [history, setHistory] = useState<{ port: number; item: ComfyHistoryItem }[]>([]);
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

    // Fetched per instance and tagged, because a wall of thumbnails from an
    // unnamed source stops being an answer as soon as there is more than one.
    const perInstance = await Promise.all(
      found.map((i) =>
        fetchComfyHistory(i.port)
          .then((items) => items.map((item) => ({ port: i.port, item })))
          .catch(() => []),
      ),
    );
    setHistory(perInstance.flat());
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
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
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
        <Alert
          type="warning"
          showIcon
          message="沒有執行中的 ComfyUI"
          description={
            <span>
              以 <code>~/ai/comfyui/run-comfyui.sh</code> 啟動。容器設定為
              <code> --restart unless-stopped</code>，開機會自動啟動。
              第二張卡再跑一次同一支腳本，帶不同的 <code>PORT</code> 與
              <code> CLI_ARGS=&quot;--oneapi-device-selector level_zero:1&quot;</code>，
              這頁會自己找到它。
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

      {/* Where the memory is going, under the instance it decides the fate of.
          Above the gallery, because it is the thing that stops the gallery
          getting any new entries. */}
      <Vram instance={instances?.[0] ?? null} />

      <Card
        title={<span style={{ fontSize: 12, opacity: 0.75 }}>最近的產出</span>}
        size="small"
        extra={
          <Space size={8}>
            {/* The one place someone standing here is likely to want next: the
                gallery says what came out, this says what can go in. */}
            <Link to="/files">
              <Button size="small" icon={<FolderOpenOutlined />}>檔案</Button>
            </Link>
            <Button size="small" onClick={() => void refresh()}>重新整理</Button>
          </Space>
        }
      >
        {history.length === 0 ? (
          <Empty
            description={
              instances?.length
                // Not a failure worth an error state: ComfyUI keeps its history
                // in memory, so a restarted container starts empty even though
                // every image it has ever made is still in the output folder.
                ? '這次啟動後尚無產出（ComfyUI 的歷史不跨重啟，圖檔仍在 output 目錄）'
                : '尚無紀錄'
            }
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Image.PreviewGroup>
            <Space wrap size={12}>
              {history.flatMap(({ port, item }) =>
                item.images.map((img) => (
                  <div key={`${port}-${item.prompt_id}-${img.filename}`} style={{ width: 160 }}>
                    <Image
                      src={comfyImageUrl(port, img)}
                      width={160}
                      height={160}
                      style={{ objectFit: 'cover', borderRadius: 6 }}
                    />
                    <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      {many && <span style={{ fontFamily: MONO }}>:{port} </span>}
                      {img.filename}
                    </Text>
                  </div>
                )),
              )}
            </Space>
          </Image.PreviewGroup>
        )}
      </Card>
    </Space>
  );
}
