import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Divider, Popconfirm, Space, Tag, Tooltip,
  Typography,
} from 'antd';
import {
  CloudDownloadOutlined, DeleteOutlined, ExportOutlined, PlusOutlined,
  ReloadOutlined, SearchOutlined, StopOutlined, SyncOutlined,
} from '@ant-design/icons';
import {
  checkComfyUpdates, comfyAction, fetchComfyConfig, fetchComfyInstances,
  fetchRuntimes, interruptComfy, restartComfy, setCardRole, updateComfy,
  type ComfyInstance, type RuntimeCoverage,
} from '../api';
import ContainerSettings from './comfy-settings';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * Image generation.
 *
 * The console does not try to be ComfyUI. It answers what an operator asks --
 * is it up, on which cards, is it busy, take me to it -- and owns the container
 * those answers come from.
 *
 * One card per instance, and everything about that instance inside it. The
 * previous arrangement had the same decision in two places that meant opposite
 * things: a per-card switch that created a second instance, and a per-card
 * checkbox that handed the card to the first one. Ticking the box made the
 * switch read as on, and turning that switch off destroyed the whole container
 * rather than detaching one card. Cards belong to an instance, so they are
 * edited inside it; making a new instance is a separate action offered only for
 * a card that has none.
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

/**
 * One instance, and everything that is true of it.
 *
 * The order is the order an operator reads in: what it is doing, the way in,
 * then what it is made of, then the things that take it away for a while. The
 * maintenance actions sit at the bottom behind a divider because every one of
 * them stops the instance for minutes, and they should not share a row with the
 * button that opens it.
 */
function Instance({ instance, staleAfterUpdate, onChanged, onRestarted }: {
  instance: ComfyInstance;
  /** True once an update has finished here but the process still runs the old
   *  code, so the card can say what is left to do. */
  staleAfterUpdate: boolean;
  onChanged: () => void;
  onRestarted: () => void;
}) {
  const { message } = AntApp.useApp();
  const [stopping, setStopping] = useState(false);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);

  const url = instanceUrl(instance);
  const busy = instance.queue_running > 0;
  const queued = instance.queue_pending;
  const manager = instance.manager;
  const updating = manager?.processing ?? false;

  // Only the name, which the maintenance actions address the container by.
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    fetchComfyConfig(instance.port)
      .then((found) => setName(found.name))
      .catch(() => setName(null));
  }, [instance.port]);

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

  const onUpdateNodes = () =>
    run('更新', setStarting, () => updateComfy(instance.port), '已開始更新');

  const onUpdateImage = () =>
    run('更新映像', setStarting, async () => {
      if (!name) throw new Error('讀不到容器名稱');
      await comfyAction(name!, 'update');
    }, '已開始下載新映像並重建');

  const onRestart = () =>
    run('重啟', setStarting, async () => {
      await restartComfy(instance.port);
      onRestarted();
    }, '已送出重啟');

  const onRemove = () =>
    run('移除', setStarting, async () => {
      if (!name) throw new Error('讀不到容器名稱');
      await comfyAction(name!, 'remove');
    }, '已移除');

  // Plain words, because this is the line that decides whether somebody who has
  // never met ComfyUI tries to use it right now. "queue_running 0 / pending 0"
  // is the same fact and answers nobody.
  const state = updating ? '更新中' : busy ? '正在算圖' : '可以使用';

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: busy || !updating ? ACCENT.ok : LINE.strong,
          }} />
          <Text style={{ fontSize: 14 }}>{state}</Text>
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
            // card and claiming the instance is not running.
            <Tooltip title="ComfyUI 正忙著算，暫時沒有回應。顯示的是最後一次拿到的數字。">
              <Tag color="blue" style={{ fontSize: 11 }}>數字為舊值</Tag>
            </Tooltip>
          )}
          {!updating && staleAfterUpdate && (
            // The files on disk changed; the running process did not. Saying so
            // is the point -- an update that silently needs a restart looks like
            // an update that did nothing.
            <Tag color="gold" style={{ fontSize: 11 }}>更新完成，待重啟</Tag>
          )}
        </Space>
      }
      extra={
        <Space size={8}>
          {busy && (
            <Button size="small" danger icon={<StopOutlined />}
                    loading={stopping} onClick={() => void onInterrupt()}>
              中斷
            </Button>
          )}
          {url ? (
            <Button type="primary" icon={<ExportOutlined />}
                    href={url} target="_blank" rel="noreferrer">
              開啟 ComfyUI
            </Button>
          ) : (
            // Reachable on loopback but with no Caddy site block in front of
            // it, so there is no authenticated way in from a browser. A link
            // that cannot connect would be worse than saying why.
            <Tooltip title="需要在 caddy/channels 補上對應的站台設定，才有經過登入的入口">
              <Button disabled>尚未發佈</Button>
            </Tooltip>
          )}
        </Space>
      }
    >
      <Text type="secondary" style={{ fontSize: 12 }}>
        ComfyUI 是畫圖的工具，操作都在它自己的介面裡。
      </Text>

      <Divider style={{ margin: '14px 0 10px' }} />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, flex: '1 1 auto' }}>
          {name ?? 'comfyui'} ・ v{instance.version} ・ :{instance.port}
          {instance.torch ? ` ・ torch ${instance.torch}` : ''}
        </Text>

        {/* Every one of these stops the instance for minutes, so they are named
            for what they change rather than all called 更新. Two of them used to
            share that word in different places on the page. */}
        <Tooltip title="問每個已安裝節點有沒有新版，要連四十次 GitHub">
          <Button size="small" icon={<SearchOutlined />}
                  loading={checking} disabled={updating}
                  onClick={() => void onCheck()}>
            檢查更新
          </Button>
        </Tooltip>
        <Tooltip title="更新容器裡的 ComfyUI 本體與自訂節點，之後要重啟才生效">
          <Button size="small" icon={<CloudDownloadOutlined />}
                  loading={starting || updating} disabled={updating}
                  onClick={() => void onUpdateNodes()}>
            更新節點
          </Button>
        </Tooltip>
        <Tooltip title="下載新的 docker 映像並用它重建容器，換的是整個執行環境">
          <Button size="small" icon={<CloudDownloadOutlined />}
                  loading={starting} disabled={updating || !name}
                  onClick={() => void onUpdateImage()}>
            更新映像
          </Button>
        </Tooltip>
        <Tooltip title="重新啟動容器裡的 ComfyUI">
          <Button size="small" icon={<ReloadOutlined />}
                  loading={starting} danger={busy}
                  onClick={() => void onRestart()}>
            重啟
          </Button>
        </Tooltip>
        <Popconfirm
          title={`移除 ${name ?? '這個容器'}？`}
          description="容器會被刪掉，output 與設定檔留在磁碟上。"
          okText="移除" cancelText="取消" okButtonProps={{ danger: true }}
          disabled={!name}
          onConfirm={() => void onRemove()}
        >
          <Button size="small" danger icon={<DeleteOutlined />} disabled={!name}>
            移除
          </Button>
        </Popconfirm>
      </div>
    </Card>
  );
}

/**
 * Cards with no instance on them.
 *
 * Only these, and only as an offer to make one. A card already belonging to an
 * instance is edited inside that instance, which is the whole point of the
 * split: creating a container and giving a container another card are different
 * decisions, and one switch cannot mean both.
 */
function Spare({ onChanged }: { onChanged: () => void }) {
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
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const create = async (row: RuntimeCoverage) => {
    const key = row.pci_bdf_address ?? row.comfy.slot;
    setBusy(key);
    try {
      await setCardRole(row.pci_bdf_address ?? '', 'images', true);
      message.success('開始建立，映像要下載一陣子');
      await load();
      onChanged();
    } catch (error) {
      message.error(`建立失敗：${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const spare = (rows ?? []).filter((r) => !r.comfy.container);
  if (!spare.length) return null;

  return (
    <Card size="small" title={<span style={{ fontSize: 12, opacity: 0.75 }}>還沒有實例的卡</span>}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {spare.map((row) => {
          const key = row.pci_bdf_address ?? row.comfy.slot;
          const job = row.comfy.job;
          const template = row.comfy.template;
          const working = !!job && job.state !== 'done' && job.state !== 'error';
          return (
            <div key={key} style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            }}>
              <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                <Text style={{ fontSize: 13 }}>{row.name ?? '不明的卡'}</Text>
                <div>
                  <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
                    {template
                      ? `會叫 comfyui-${row.comfy.slot}${row.comfy.image_size ? ` ・ 映像 ${row.comfy.image_size}` : ''}`
                      : '沒有這家廠商的 ComfyUI 映像範本'}
                  </Text>
                </div>
              </div>

              {working && job ? (
                <Space size={6}>
                  <SyncOutlined spin style={{ fontSize: 12, opacity: 0.7 }} />
                  <Text style={{ fontSize: 12, fontFamily: MONO }}>
                    {job.state === 'pulling'
                      ? `下載中 ${job.layers_done}/${job.layers_total}` : '啟動中'}
                  </Text>
                </Space>
              ) : (
                <Popconfirm
                  title={`在這張卡上建立 comfyui-${row.comfy.slot}？`}
                  description="會下載十幾 GB 的映像，需要一段時間。"
                  okText="建立" cancelText="取消"
                  disabled={!template}
                  onConfirm={() => void create(row)}
                >
                  <Button size="small" icon={<PlusOutlined />}
                          loading={busy === key} disabled={!template}>
                    建立實例
                  </Button>
                </Popconfirm>
              )}
            </div>
          );
        })}
      </Space>
    </Card>
  );
}

export default function ComfyUI() {
  const [instances, setInstances] = useState<ComfyInstance[] | null>(null);
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {instances !== null && instances.length === 0 && (
        // The instructions used to be a shell script to run by hand. Creating an
        // instance is a button below now, and pointing at a terminal for
        // something already on screen is worse than saying nothing.
        <Alert
          type="warning"
          showIcon
          message="沒有執行中的 ComfyUI"
          description="在下面挑一張卡建立實例。映像約 20 GB，第一次要下載一陣子；建好之後容器會 restart unless-stopped，開機自動啟動。"
        />
      )}

      {/* One row per instance: what it is doing on the left, what it is made
          of on the right. The two questions do not interleave -- one is
          answered by pressing something and watching, the other by editing a
          form and rebuilding -- and each instance carries its own pair, so a
          second card's settings can never be edited under the first one's
          heading. They stack below 900px. */}
      {instances?.map((i) => (
        <div key={i.port} style={{
          display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap',
        }}>
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            <Instance
              instance={i}
              staleAfterUpdate={stale.has(i.port)}
              onChanged={() => void refresh()}
              onRestarted={() => setStale((prev) => {
                const next = new Set(prev);
                next.delete(i.port);
                return next;
              })}
            />
          </div>
          <div style={{ flex: '1 1 380px', minWidth: 0, maxWidth: 520 }}>
            <ContainerSettings instance={i} onDone={() => void refresh()} />
          </div>
        </div>
      ))}

      <Spare onChanged={() => void refresh()} />
    </Space>
  );
}
