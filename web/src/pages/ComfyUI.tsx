import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert, App as AntApp, Button, Card, Divider, Popconfirm, Segmented, Space, Tag,
  Tooltip, Typography,
} from 'antd';
import {
  ExportOutlined, PlayCircleOutlined, PlusOutlined, StopOutlined, SyncOutlined,
} from '@ant-design/icons';
import {
  controlContainer, fetchComfyInstances, fetchComfyStorage, fetchContainerHistory,
  fetchRuntimes, interruptComfy, pullText, setCardRole,
  type ComfyInstance, type ComfyStorage, type GpuSample, type RuntimeCoverage,
} from '../api';
import { useStream } from '../stream';
import { useIsOwner } from '../identity';
import ContainerCard from './comfy-settings';
import MetricChart from '../components/MetricChart';
import { ACCENT, LINE, MONO, SERIES } from '../theme';

const { Text } = Typography;

/**
 * Image generation.
 *
 * Two audiences read this page and they want different amounts of it.
 * Somebody who wants a picture needs three things: is it free, the button
 * that opens it, and what to do once they are in. The administrator needs
 * those plus what the instance is costing, how to update it, and how it is
 * built. So the page is one column in that order -- the first two cards are
 * for everyone, everything under them appears only to the administrator --
 * and nothing an operator needs sits beside something a newcomer needs.
 *
 * The console does not try to be ComfyUI. It answers what an operator asks
 * and owns the container those answers come from; the drawing happens in
 * ComfyUI's own interface, which is what the big button opens.
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

const gib = (bytes: number) => bytes / 1024 ** 3;

/** Bytes in the unit the figure is read in: a 67 GiB model tree and a 12 MiB
 *  input folder should not both be forced into one of them. */
const size = (bytes: number | null) =>
  (bytes === null ? '—'
    : bytes >= 1024 ** 3 ? `${gib(bytes).toFixed(1)}G`
      : `${Math.max(1, Math.round(bytes / 1024 ** 2))}M`);

/** system_stats says "0.36.0"; the release list says "v0.36.0". */
const tagged = (v: unknown) => (typeof v === 'string' && v ? 'v' + v.replace(/^v/, '') : null);

/** "Intel(R) Arc(TM) Pro B70 Graphics" as somebody would say it. */
const cardName = (name: string | undefined) =>
  (name ?? '').replace(/^\w+:\d+\s+/, '').replace(/\((R|TM)\)/g, '').replace(/\s+Graphics$/, '');

/**
 * The card from the host's side. ComfyUI's own vram_free is torch's view from
 * inside the container, and on XPU that is the whole card free while
 * llama-server sits on 27 GiB of it -- which is exactly the case worth
 * showing. Anything on the card that is not ComfyUI's is "others": the
 * language model, or the desktop.
 */
function cardFigures(instance: ComfyInstance, gpus: GpuSample[]) {
  const card = gpus.find((g) => g.index === instance.cards[0]);
  const used = card?.memory_used_mib != null ? card.memory_used_mib * 1024 ** 2 : null;
  const total = card?.memory_total_mib != null ? card.memory_total_mib * 1024 ** 2 : null;
  const own = instance.device ? instance.device.torch_vram_total : null;
  return {
    used, total, own,
    percent: used !== null && total ? used / total * 100 : null,
    others: used !== null && own !== null ? Math.max(0, used - own) : null,
  };
}

/** Past this much held by something else, a picture of any size is at
 *  risk, and it is worth saying so before Run rather than after. */
const CROWDED = 4 * 1024 ** 3;

/**
 * Is it free, the way in, and what to do once inside.
 *
 * The three steps are on the card rather than in a help page because the
 * question they answer is asked standing in front of this screen, and they
 * are numbered because they happen in that order. The last one says where
 * the pictures go, which is the question that otherwise arrives ten minutes
 * later.
 */
function Hero({ instance, slot, onChanged }: {
  instance: ComfyInstance;
  slot: string | null;
  onChanged: () => void;
}) {
  const { message } = AntApp.useApp();
  const { gpus } = useStream();
  const [stopping, setStopping] = useState(false);

  const url = instanceUrl(instance);
  const busy = instance.queue_running > 0;
  const queued = instance.queue_pending;
  const manager = instance.manager;
  const updating = manager?.processing ?? false;
  const { others } = cardFigures(instance, gpus);
  const crowded = others !== null && others >= CROWDED;

  // Plain words, because this is the line that decides whether somebody who
  // has never met ComfyUI tries to use it right now.
  const state = updating ? '更新中' : busy ? '正在算圖' : '可以使用';
  const dot = updating ? LINE.strong : ACCENT.ok;

  const onInterrupt = async () => {
    setStopping(true);
    try {
      await interruptComfy(instance.port);
      message.success('已送出中斷');
      onChanged();
    } catch (error) {
      message.error(`中斷失敗：${(error as Error).message}`);
    } finally {
      setStopping(false);
    }
  };

  const steps: { title: string; body: ReactNode }[] = [
    {
      title: '開啟',
      body: '按右上角的按鈕，ComfyUI 會在新分頁打開，不用再登入一次。',
    },
    {
      title: '載入工作流程',
      body: '上方選單 Workflow → Browse Templates 挑一個範本，或把 .json 檔直接拖進畫面。',
    },
    {
      title: '算圖',
      body: (
        <>
          改好提示詞按 Run。做好的圖會存在 output 資料夾
          {slot ? <>，<Link to={`/files?root=output-${slot}`}>到檔案頁看</Link></> : ''}。
        </>
      ),
    },
  ];

  // The same scale as every other card here: the state where a card's
  // title goes, the button at the size the rest of the console uses, 11px
  // notes. The first cut had the state at 20px and the button large, which
  // made this the one loud card in a quiet interface.
  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
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
            // while a sampling step runs. Saying the numbers paused beats
            // presenting them as current or dropping the card.
            <Tooltip title="ComfyUI 正忙著算，暫時沒有回應。畫面上是最後一次拿到的數字。">
              <Tag color="blue" style={{ fontSize: 11 }}>數字暫停更新</Tag>
            </Tooltip>
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
            // Outlined, like 新建 on the Files page: the filled primary is a
            // grey slab on this background, and the one thing to click on a
            // page should not be the one ugly thing on it.
            <Button size="small" type="primary" ghost icon={<ExportOutlined />}
                    href={url} target="_blank" rel="noreferrer">
              開啟 ComfyUI
            </Button>
          ) : (
            // Reachable on loopback but with no Caddy site block in front of
            // it, so there is no authenticated way in from a browser. A link
            // that cannot connect would be worse than saying why.
            <Tooltip title="需要在 caddy/channels 補上對應的站台設定，才有經過登入的入口">
              <Button size="small" disabled>尚未發佈</Button>
            </Tooltip>
          )}
        </Space>
      }
    >
      <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
        {instance.container ?? 'comfyui'}
        {instance.device?.name ? ` ・ ${cardName(instance.device.name)}` : ''}
        {tagged(instance.version) ? ` ・ ComfyUI ${tagged(instance.version)}` : ''}
      </Text>
      {crowded && others !== null && (
        // The failure a newcomer actually hits: Run, then an out-of-memory
        // error from inside ComfyUI, because the language model is on the
        // card. Said here, before Run, with the two ways out. The console
        // clears ComfyUI for a model but not the reverse -- the model leaves
        // on its own idle timer, or when somebody unloads it.
        <Text style={{ fontSize: 11, color: ACCENT.warn, display: 'block', marginTop: 6 }}>
          顯示卡上有其他程式（通常是語言模型）佔著 {gib(others).toFixed(1)} GiB，大一點的圖可能算不了。
          它閒置一陣子會自己卸載，或到<Link to="/models" style={{ color: ACCENT.warn, textDecoration: 'underline' }}>模型頁</Link>按「全部卸載」。
        </Text>
      )}

      <Divider style={{ margin: '12px 0 10px' }} />

      <div style={{
        display: 'grid', gap: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      }}>
        {steps.map((step, i) => (
          <div key={step.title} style={{ display: 'flex', gap: 10, minWidth: 0 }}>
            <span style={{
              fontFamily: MONO, fontSize: 14, lineHeight: 1.3, opacity: 0.35, flex: 'none',
              width: 12, textAlign: 'right',
            }}>
              {i + 1}
            </span>
            <div style={{ minWidth: 0 }}>
              <Text style={{ fontSize: 12, display: 'block' }}>{step.title}</Text>
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2, lineHeight: 1.6 }}>
                {step.body}
              </Text>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const WINDOWS = [
  { label: '5 分', value: 300 },
  { label: '15 分', value: 900 },
  { label: '1 時', value: 3600 },
  { label: '2 時', value: 7200 },
];

interface Point { t: number; v: number | null }

/**
 * The top of the memory axis: the container's limit when it has one, else
 * the whole-number power of two above the highest reading in the window.
 * Not the host's 126 GiB, against which a 2 GiB container is a flat line
 * however hard it works; not fitted to the data either, or a steady hour
 * would fill the panel. A power of two only moves when a peak passes it.
 */
function memoryCeiling(limit: number | null | undefined, points: Point[]): number {
  if (limit) return limit;
  const peak = Math.max(0, ...points.map((p) => p.v ?? 0));
  let top = 1024 ** 3;
  while (top < peak) top *= 2;
  return top;
}

/**
 * What the instance is using, over the last while.
 *
 * Two panels drawn the way the overview's GPU chart is drawn, one quantity
 * each: the container's CPU and memory from its cgroup. The card is not
 * here -- it is on the overview and the GPU page already, and the one fact
 * about it that matters on this page (something else is sitting on it) is
 * said on the status card before Run. Disk is not a time series -- it is
 * walked every five minutes -- so what the instance's directories weigh is
 * a line under the panels rather than a third one.
 */
function Resources({ instance, storage }: {
  instance: ComfyInstance;
  storage: ComfyStorage | null;
}) {
  const { containers, system } = useStream();
  const [seconds, setSeconds] = useState(900);
  const [cpu, setCpu] = useState<Point[]>([]);
  const [memory, setMemory] = useState<Point[]>([]);
  const name = instance.container;

  // The window before the page opened, from the server's buffer. Refetched
  // occasionally so the far edge stays honest; the live feed fills in
  // between.
  const load = useCallback(async (window: number) => {
    if (!name) return;
    try {
      const series = (await fetchContainerHistory(window, 240)).series[name] ?? [];
      setCpu(series.map((p) => ({ t: p.t, v: p.cpu })));
      setMemory(series.map((p) => ({ t: p.t, v: p.memory })));
    } catch {
      // Leave whatever is on screen rather than blanking the panels.
    }
  }, [name]);

  useEffect(() => { void load(seconds); }, [seconds, load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(seconds), 30000);
    return () => window.clearInterval(timer);
  }, [seconds, load]);

  // Each live sample appended to its series, capped to the window so a page
  // left open overnight does not grow without bound.
  const append = useCallback((prev: Point[], point: Point) => {
    if (prev.length && prev[prev.length - 1].t === point.t) return prev;
    const cutoff = point.t - seconds;
    return [...prev.filter((p) => p.t >= cutoff), point];
  }, [seconds]);

  useEffect(() => {
    const sample = name ? containers.find((c) => c.name === name) : undefined;
    if (!sample) return;
    setCpu((prev) => append(prev, { t: sample.t, v: sample.cpu_percent }));
    setMemory((prev) => append(prev, { t: sample.t, v: sample.memory }));
  }, [containers, name, append]);

  const cores = system?.cpu.cores ?? null;
  const sample = name ? containers.find((c) => c.name === name) : undefined;

  const total = storage?.measured_at
    ? (storage.models_bytes ?? 0) + (storage.input_bytes ?? 0)
      + (storage.output_bytes ?? 0) + (storage.install_bytes ?? 0)
    : null;

  return (
    <Card
      size="small"
      title={<span style={{ fontSize: 12, opacity: 0.75 }}>資源</span>}
      extra={
        <Segmented size="small" value={seconds}
                   onChange={(v) => setSeconds(v as number)} options={WINDOWS} />
      }
    >
      <div style={{
        display: 'grid', gap: 20,
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
      }}>
        <MetricChart
          label="CPU"
          points={cpu}
          colour={SERIES.temp}
          // The figure docker stats prints: one core flat out is 100%, so
          // the top of the axis is every core at once. The same number the
          // runtime page shows for this container.
          max={(cores ?? 16) * 100}
          axis={(v) => `${v}%`}
          format={(v) => `${v.toFixed(0)}%`}
          note={cores ? `100% 是 1 核，共 ${cores} 核` : undefined}
        />
        <MetricChart
          label="記憶體"
          points={memory}
          colour={SERIES.power}
          max={memoryCeiling(sample?.memory_limit, memory)}
          // A 2 GiB axis has ticks at half-gigabytes; rounded to whole ones
          // they read 0G 1G 1G 2G 2G.
          axis={(v) => `${Number.isInteger(gib(v)) ? gib(v) : gib(v).toFixed(1)}G`}
          format={(v) => `${gib(v).toFixed(2)} GiB`}
          note={sample?.memory_limit ? `容器上限 ${gib(sample.memory_limit).toFixed(0)} GiB` : '無上限，與主機共用'}
        />
      </div>

      <Divider style={{ margin: '12px 0 10px' }} />

      <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
        佔用空間 {total !== null ? `${gib(total).toFixed(1)} GiB` : storage ? '計算中…' : '—'}
        {storage?.measured_at
          ? ` ・ 模型 ${size(storage.models_bytes)}（各實例共用）・ 成品 ${size(storage.output_bytes)}`
            + ` ・ 程式 ${size(storage.install_bytes)} ・ 素材 ${size(storage.input_bytes)}`
          : ''}
      </Text>
    </Card>
  );
}

/**
 * Cards that have nothing running on them.
 *
 * Two shapes, and both have to be here or one of them becomes unreachable. A
 * card with no container at all is an offer to make one. A card whose container
 * exists but is stopped is an offer to start it -- and without that row a
 * stopped instance is invisible: the instance list is built by probing ports, so
 * a stopped container answers nothing and vanishes from the page, while this
 * list would have skipped it for having a container. Stopping it would have been
 * a one-way door.
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

  const start = async (row: RuntimeCoverage) => {
    const key = row.pci_bdf_address ?? row.comfy.slot;
    setBusy(key);
    try {
      await controlContainer(row.comfy.container ?? '', 'start');
      message.success('已啟動');
      await load();
      onChanged();
    } catch (error) {
      message.error(`啟動失敗：${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const stateOf = (row: RuntimeCoverage) =>
    row.containers.find((c) => c.name === row.comfy.container)?.state ?? '';
  const spare = (rows ?? []).filter(
    (r) => !r.comfy.container || stateOf(r) !== 'running');
  if (!spare.length) return null;

  return (
    <Card size="small" title={<span style={{ fontSize: 12, opacity: 0.75 }}>沒有在跑的卡</span>}>
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
                    {row.comfy.container
                      ? `${row.comfy.container} ・ 已停止`
                      : template
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
                      ? `下載中 ${pullText(job)}` : '啟動中'}
                  </Text>
                </Space>
              ) : row.comfy.container ? (
                <Button size="small" type="primary" ghost icon={<PlayCircleOutlined />}
                        loading={busy === key} onClick={() => void start(row)}>
                  啟動
                </Button>
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

/** One instance top to bottom: for everyone, then for the administrator. */
function InstanceSection({ instance, owner, staleAfterUpdate, onChanged, onRestarted }: {
  instance: ComfyInstance;
  owner: boolean;
  staleAfterUpdate: boolean;
  onChanged: () => void;
  onRestarted: () => void;
}) {
  const [storage, setStorage] = useState<ComfyStorage | null>(null);
  const slot = instance.container?.replace(/^comfyui-/, '') ?? null;

  // Disk changes by the batch, not by the second. The backend walks the
  // directories at most every five minutes; this just asks often enough to
  // see the first answer arrive.
  useEffect(() => {
    let live = true;
    const load = () => {
      fetchComfyStorage(instance.port)
        .then((found) => { if (live) setStorage(found); })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 20000);
    return () => { live = false; window.clearInterval(timer); };
  }, [instance.port]);

  // A flex column with a gap, as the overview lays out its blocks. Not an
  // antd Space: that spaces its direct children only, and this section is
  // one child of the page's list, so its cards were sitting flush.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Hero instance={instance} slot={slot} onChanged={onChanged} />
      <Resources instance={instance} storage={storage} />
      {owner && (
        <ContainerCard instance={instance} staleAfterUpdate={staleAfterUpdate}
                       onChanged={onChanged} onRestarted={onRestarted} />
      )}
    </div>
  );
}

export default function ComfyUI() {
  const owner = useIsOwner();
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
    // The backend restarts an updated instance on its own now; one it is
    // handling is not waiting on anybody's button.
    setStale((prev) => {
      const kept = [...prev].filter((p) => found.some((i) => i.port === p && !i.after_update));
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {instances !== null && instances.length === 0 && (
        <Alert
          type="warning"
          showIcon
          message="沒有執行中的 ComfyUI"
          description={owner
            ? '在下面挑一張卡建立實例。映像約 20 GB，第一次要下載一陣子；建好之後容器會 restart unless-stopped，開機自動啟動。'
            : '請找管理員把它啟動。'}
        />
      )}

      {instances?.map((i) => (
        <InstanceSection
          key={i.port}
          instance={i}
          owner={owner}
          staleAfterUpdate={stale.has(i.port)}
          onChanged={() => void refresh()}
          onRestarted={() => setStale((prev) => {
            const next = new Set(prev);
            next.delete(i.port);
            return next;
          })}
        />
      ))}

      {/* Under the instances, because creating one is an operation and
          belongs after the ones that exist. */}
      {owner && <Spare onChanged={() => void refresh()} />}
    </div>
  );
}
