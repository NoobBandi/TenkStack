import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert, App as AntApp, Button, Card, Divider, Popconfirm, Space, Tag, Tooltip,
  Typography,
} from 'antd';
import {
  CloudDownloadOutlined, DeleteOutlined, ExportOutlined, PlayCircleOutlined,
  PlusOutlined, PoweroffOutlined, ReloadOutlined, StopOutlined, SyncOutlined,
} from '@ant-design/icons';
import {
  checkComfyVersion, comfyAction, controlContainer, fetchComfyInstances,
  fetchComfyStorage, fetchRuntimes, interruptComfy, restartComfy, setCardRole,
  updateComfy,
  type ComfyInstance, type ComfyStorage, type GpuSample, type RuntimeCoverage,
} from '../api';
import { useStream } from '../stream';
import { useIsOwner } from '../identity';
import ContainerSettings from './comfy-settings';
import { StatBody } from '../components/StatTile';
import { ACCENT, LINE, MONO, VRAM_AMBER, VRAM_RED } from '../theme';

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

function ago(seconds: number | null): string {
  if (seconds === null) return '';
  const m = Math.round((Date.now() / 1000 - seconds) / 60);
  return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : `${Math.round(m / 60)} 小時前`;
}

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

/**
 * What the instance is using, right now.
 *
 * The same tile the GPU page uses, so a reading here looks like a reading
 * there. CPU and memory are the container's cgroup by way of the live
 * stream; the card is as ComfyUI reports it; disk is what the instance's own
 * directories weigh, not the drive they sit on -- the drive is the host's
 * business and is on the overview.
 */
function Resources({ instance, storage }: {
  instance: ComfyInstance;
  storage: ComfyStorage | null;
}) {
  const { containers, system, gpus } = useStream();
  const name = instance.container;
  const sample = name ? containers.find((c) => c.name === name) : undefined;
  const cores = system?.cpu.cores ?? null;
  const hostMemory = system?.memory.total_bytes ?? null;

  // cpu_percent is of one core: 350 means three and a half cores.
  const cpuCores = sample?.cpu_percent != null ? sample.cpu_percent / 100 : null;

  const { used: cardUsed, total: cardTotal, percent: cardPercent, own, others } = cardFigures(instance, gpus);

  const total = storage?.measured_at
    ? (storage.models_bytes ?? 0) + (storage.input_bytes ?? 0)
      + (storage.output_bytes ?? 0) + (storage.install_bytes ?? 0)
    : null;

  return (
    <Card size="small" title={<span style={{ fontSize: 12, opacity: 0.75 }}>資源</span>}>
      <div style={{
        display: 'grid', gap: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      }}>
        <StatBody
          label="CPU"
          value={cpuCores !== null ? cpuCores.toFixed(1) : '—'}
          unit="核"
          percent={cpuCores !== null && cores ? cpuCores / cores * 100 : undefined}
          footnote={cores ? `共 ${cores} 核` : undefined}
        />
        <StatBody
          label="記憶體"
          value={sample ? gib(sample.memory).toFixed(1) : '—'}
          unit="GiB"
          percent={sample && hostMemory ? sample.memory / hostMemory * 100 : undefined}
          footnote={sample?.memory_limit
            ? `容器上限 ${gib(sample.memory_limit).toFixed(0)} GiB`
            : hostMemory ? `主機共 ${gib(hostMemory).toFixed(0)} GiB` : undefined}
        />
        <StatBody
          label="顯示記憶體"
          value={cardUsed !== null ? gib(cardUsed).toFixed(1) : '—'}
          unit="GiB"
          percent={cardPercent ?? undefined}
          thresholds={[VRAM_AMBER, VRAM_RED]}
          footnote={
            cardTotal && own !== null && others !== null
              ? (cardPercent ?? 0) >= VRAM_AMBER
                ? `快滿了，算圖可能失敗（ComfyUI 佔 ${gib(own).toFixed(1)}，其他程式 ${gib(others).toFixed(1)} GiB）`
                : others >= 1 << 30
                  ? `ComfyUI 佔 ${gib(own).toFixed(1)}，其他程式 ${gib(others).toFixed(1)} GiB`
                  : `ComfyUI 佔 ${gib(own).toFixed(1)} GiB，卡上共 ${gib(cardTotal).toFixed(0)} GiB`
              : undefined
          }
        />
        <StatBody
          label="佔用空間"
          value={total !== null ? gib(total).toFixed(1) : '—'}
          unit="GiB"
          // Not a ratio: the drive it sits on is on the overview page. The
          // parts are the footnote, because the one that grows is 成品.
          footnote={storage?.measured_at
            ? `模型 ${size(storage.models_bytes)} ・ 成品 ${size(storage.output_bytes)}`
              + ` ・ 程式 ${size(storage.install_bytes)} ・ 素材 ${size(storage.input_bytes)}`
            : storage ? '正在計算…' : undefined}
        />
      </div>
    </Card>
  );
}

/**
 * The things that take the instance away for a while.
 *
 * A list, not a row of equal buttons: as a row they were indistinguishable,
 * and the only thing separating "update the nodes" from "replace the whole
 * runtime" was a tooltip nobody hovers. The sentence beside each is what
 * that tooltip used to hide. Remove is apart, because it does not come back.
 */
function Maintenance({ instance, staleAfterUpdate, onChanged, onRestarted }: {
  instance: ComfyInstance;
  /** True once an update has finished here but the process still runs the old
   *  code, so the card can say what is left to do. */
  staleAfterUpdate: boolean;
  onChanged: () => void;
  onRestarted: () => void;
}) {
  const { message } = AntApp.useApp();
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);

  const name = instance.container;
  const busy = instance.queue_running > 0;
  const manager = instance.manager;
  const updating = manager?.processing ?? false;

  /** `done` is optional: an action that reports its own result says it once. */
  const run = async (
    label: string,
    action: () => Promise<unknown>,
    done?: string,
  ) => {
    setStarting(true);
    try {
      await action();
      if (done) message.success(done);
      onChanged();
    } catch (error) {
      message.error(`${label}失敗：${(error as Error).message}`);
    } finally {
      setStarting(false);
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

  const current = tagged(instance.version);
  const latest = instance.latest;
  const behind = !!current && !!latest && current !== latest;

  const actions = [
    {
      key: 'nodes', label: '更新節點', icon: <CloudDownloadOutlined />,
      note: '更新容器裡的 ComfyUI 與所有自訂節點，之後要重啟才生效',
      loading: starting || updating, disabled: updating || !manager,
      run: () => run('更新', () => updateComfy(instance.port), '已開始更新'),
    },
    {
      key: 'image', label: '更新映像', icon: <CloudDownloadOutlined />,
      note: '下載新的 docker 映像重建容器，換掉整個執行環境',
      loading: starting, disabled: updating || !name,
      run: () => run('更新映像', () => comfyAction(name!, 'update'), '已開始下載新映像並重建'),
    },
    {
      key: 'restart', label: '重啟', icon: <ReloadOutlined />,
      note: '重新啟動容器裡的 ComfyUI',
      loading: starting, disabled: false,
      run: () => run('重啟', async () => { await restartComfy(instance.port); onRestarted(); }, '已送出重啟'),
    },
    {
      // Stopping keeps the container, and `--restart unless-stopped` means a
      // container stopped by hand stays stopped across a reboot. That is the
      // difference from 移除, and the reason both exist: one parks it, the
      // other ends it.
      key: 'stop', label: '停止', icon: <PoweroffOutlined />,
      note: '停掉容器但留著，之後可以再啟動；重開機也不會自己起來',
      loading: starting, disabled: !name,
      run: () => run('停止', () => controlContainer(name!, 'stop'), '已停止'),
    },
  ];

  return (
    <Card
      size="small"
      title={<span style={{ fontSize: 12, opacity: 0.75 }}>維護</span>}
      extra={
        <Space size={8} wrap>
          <Text style={{ fontSize: 12, fontFamily: MONO }}>ComfyUI {current ?? '—'}</Text>
          {behind ? (
            <Tag color="gold" style={{ fontSize: 11, marginInlineEnd: 0 }}>有新版 {latest}</Tag>
          ) : latest ? (
            <Text type="secondary" style={{ fontSize: 11 }}>已是最新</Text>
          ) : manager ? (
            <Text type="secondary" style={{ fontSize: 11 }}>還沒查過</Text>
          ) : (
            <Tooltip title="沒有 ComfyUI-Manager，主控台無法替它查版本或更新">
              <Text type="secondary" style={{ fontSize: 11 }}>沒有 Manager</Text>
            </Tooltip>
          )}
          {staleAfterUpdate && !updating && (
            // The files on disk changed; the running process did not. Saying
            // so is the point -- an update that silently needs a restart looks
            // like an update that did nothing.
            <Tag color="gold" style={{ fontSize: 11, marginInlineEnd: 0 }}>更新完成，待重啟</Tag>
          )}
          {manager && (
            <Button type="link" size="small" loading={checking} onClick={() => void onCheck()}
                    style={{ padding: 0, height: 'auto', fontSize: 11 }}>
              {instance.latest_checked_at ? `再查（${ago(instance.latest_checked_at)}查過）` : '查一下'}
            </Button>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {actions.map((action) => (
          <div key={action.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button
              size="small" icon={action.icon}
              loading={action.loading} disabled={action.disabled}
              danger={action.key === 'restart' && busy}
              style={{ width: 104, flex: 'none' }}
              onClick={() => void action.run()}
            >
              {action.label}
            </Button>
            <Text type="secondary" style={{ fontSize: 11, minWidth: 0 }}>{action.note}</Text>
          </div>
        ))}
      </Space>

      <Divider style={{ margin: '12px 0 10px' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Popconfirm
          title={`移除 ${name ?? '這個容器'}？`}
          description="容器會被刪掉，output 與設定檔留在磁碟上。"
          okText="移除" cancelText="取消" okButtonProps={{ danger: true }}
          disabled={!name}
          onConfirm={() => void run('移除', () => comfyAction(name!, 'remove'), '已移除')}
        >
          <Button size="small" danger icon={<DeleteOutlined />} disabled={!name}
                  style={{ width: 104, flex: 'none' }}>
            移除
          </Button>
        </Popconfirm>
        <Text type="secondary" style={{ fontSize: 11, minWidth: 0 }}>
          刪掉容器本身。output、工作流程與設定都在磁碟上，不會跟著走
        </Text>
      </div>
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
                      ? `下載中 ${job.layers_done}/${job.layers_total}` : '啟動中'}
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

  return (
    <>
      <Hero instance={instance} slot={slot} onChanged={onChanged} />
      <Resources instance={instance} storage={storage} />
      {owner && (
        <>
          <Maintenance instance={instance} staleAfterUpdate={staleAfterUpdate}
                       onChanged={onChanged} onRestarted={onRestarted} />
          <ContainerSettings instance={instance} onDone={onChanged} />
        </>
      )}
    </>
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
    </Space>
  );
}
