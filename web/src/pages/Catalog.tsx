import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Empty, Input, List, Pagination, Progress, Select,
  Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import {
  CloseOutlined, CloudDownloadOutlined, InfoCircleOutlined, StopOutlined,
} from '@ant-design/icons';
import { LINE, MONO } from '../theme';
import {
  cancelDownload, catalogFiles, catalogFolder, catalogVariants, estimateFile, fetchDownloads, fetchGpuDevices,
  fetchModelLocations, fetchProviders, locationName, searchCatalog, startDownload,
  startFolderDownload, subscribe, withinLocation,
  type CatalogFile, type CatalogFolder, type CatalogFormat, type CatalogRepo, type CatalogSearch,
  type CatalogVariant,
  type DownloadStatus,
  type FileEstimate, type GpuDevice, type ModelLocation, type ProviderCard, type Runtime,
} from '../api';
import CatalogFolderPanel, { type Plan } from '../components/CatalogFolder';

const { Text } = Typography;

/** Used until the cards have been read: one B70's 32 GiB. */
const VRAM_GIB = 32;

/** What an estimate rests on, said beside it rather than in a footnote.
 *  `校準` reproduces a model measured on this card; `外推` is the same physics
 *  applied to a shape nobody here has measured; `粗估` means something in the
 *  file is known to make the number optimistic. */
const CONFIDENCE = {
  calibrated: { color: 'green', label: '校準' },
  extrapolated: { color: 'blue', label: '外推' },
  rough: { color: 'orange', label: '粗估' },
} as const;

/** The reasoning behind one estimate. Shown on hover because the digits alone
 *  invite more trust than they have earned -- what the number assumed about
 *  depth, speculative decoding and expert routing moves it more than its own
 *  precision does. */
function EstimateDetail({ file }: { file: FileEstimate }) {
  const est = file.estimate;
  return (
    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
      <div>
        {file.architecture}
        {file.layers ? ` · ${file.layers} 層` : ''}
        {file.attention_layers && file.attention_layers !== file.layers
          ? `（僅 ${file.attention_layers} 層有 KV）` : ''}
        {file.expert_count
          ? ` · ${file.expert_count} 專家取 ${file.expert_used_count}` : ''}
      </div>
      <div>
        每 token 讀 {est.read_gib_per_token} GiB 權重，KV 每 token {est.kv_kib_per_token} KiB
      </div>
      <div>在 {est.depth} token 深度、關閉推測解碼下估算</div>
      <div>{Math.round(est.window / 1024)}K 視窗約需 {est.vram_gib} GiB 顯存</div>
      {est.notes.map((note) => (
        <div key={note} style={{ marginTop: 4 }}>· {note}</div>
      ))}
    </div>
  );
}

const keyOf = (d: DownloadStatus) => `${d.repo_id}/${d.filename}`;

const ENDED = ['done', 'error', 'cancelled'];

/**
 * Page-size choices, plus a 全部 that is just the whole set as one page.
 *
 * Sizes at or above the total are dropped: offering "100 筆" over 23 results is
 * three identical choices wearing different numbers. What is left is always a
 * real reduction, and the last option is always everything.
 */
const PAGE_SIZES = [10, 25, 50, 100];

function sizeOptions(total: number) {
  return [
    ...PAGE_SIZES.filter((n) => n < total).map((n) => ({ value: n, label: `${n} 筆` })),
    { value: Math.max(total, 1), label: '全部' },
  ];
}

/**
 * The page-size control, with its text cursor taken away.
 *
 * antd hardcodes `showSearch: true` on this Select, which turns a list of four
 * fixed choices into a text field. There is nothing to search -- the options
 * fit on screen -- and a caret invites typing a number that will not be
 * accepted, since anything not matching an option simply filters the list to
 * nothing. Passing it back is enough: the props given here are spread after
 * antd's own.
 */
const sizeChanger = (total: number) => ({
  options: sizeOptions(total),
  showSearch: false,
});

/** Locale for every paginator here, so "第 1-10 筆，共 100 筆" reads the same. */
const pageTotal = (total: number, range: [number, number]) =>
  `第 ${range[0]}-${range[1]} 筆，共 ${total} 筆`;

/** antd fixes the sidebar's collapse trigger over the bottom of the window.
 *  Its top edge is the line everything here stops at. */
const TRIGGER_TOP = 48;

/** A small Card's header, which sits above the body being sized. */
const CARD_HEAD = 39;

/** A small Table's own header row, inside the box its rows scroll in. */
const TABLE_HEAD = 39;

/**
 * Height that takes an element from where it sits down to the collapse
 * trigger, so the panels end on the same line as it.
 *
 * Measured rather than subtracted from 100vh with a constant, because what sits
 * above these panels changes: the downloads strip appears when a transfer
 * starts and disappears when the last one is dismissed, moving everything below
 * it by its own height. Any fixed guess is wrong in one of those two states.
 */
function useFillToTrigger(
  ref: React.RefObject<HTMLElement | null>,
  reserve: number,
  deps: unknown[],
): number {
  const [height, setHeight] = useState(420);

  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setHeight(Math.max(220, window.innerHeight - TRIGGER_TOP - top - reserve));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, reserve, ...deps]);

  return height;
}

/**
 * An element's own height, as laid out.
 *
 * For the box a flex column hands its leftover space to: nothing computes that
 * number in advance, and guessing what sits below it -- a paginator that may or
 * may not be there, a footnote that may or may not be there -- is how the two
 * panels stopped agreeing on where the bottom was.
 *
 * No feedback loop: the box is `flex: 1` with hidden overflow, so its height
 * comes from the column and not from whatever is measured into it.
 */
function useElementHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  });
  return height;
}

/** Truncated, and slid to its tail on hover. See `.slide` in index.css. */
function Slide({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span className="slide" style={style}><span>{children}</span></span>;
}

/** How long ago a repo was touched. A GGUF repo that has not moved in a year is
 *  usually a re-quant of something since superseded. */
function since(iso: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return '今天更新';
  if (days < 30) return `${days} 天前更新`;
  if (days < 365) return `${Math.floor(days / 30)} 個月前更新`;
  return `${Math.floor(days / 365)} 年前更新`;
}

/** How each state reads: bar style, label, and whether the row can be dropped. */
const STATE_VIEW: Record<string, { status: 'active' | 'success' | 'exception' | 'normal';
                                   label: string; tag?: string }> = {
  queued: { status: 'active', label: '排隊中' },
  downloading: { status: 'active', label: '下載中' },
  verifying: { status: 'active', label: '驗證中' },
  done: { status: 'success', label: '完成', tag: 'success' },
  error: { status: 'exception', label: '失敗', tag: 'error' },
  cancelled: { status: 'normal', label: '已取消' },
};

export default function Catalog() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  // A search finds both formats; this narrows what it found, the way the
  // model page's engine filter does, without asking the Hub again.
  const [formatFilter, setFormatFilter] = useState<'all' | CatalogFormat>('all');
  // The format of the repository on the right, which decides how it is shown:
  // a choice of files, or a folder. Found with it, not assumed from the mode.
  const [pickedFormat, setPickedFormat] = useState<CatalogFormat | null>(null);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [engines, setEngines] = useState<ProviderCard[]>([]);
  const [enginesLoaded, setEnginesLoaded] = useState(false);
  const [gpus, setGpus] = useState<GpuDevice[]>([]);
  const [folder, setFolder] = useState<CatalogFolder | null>(null);
  const [variants, setVariants] = useState<CatalogVariant[] | null>(null);
  useEffect(() => {
    fetchProviders().then((p) => { setRuntimes(p.runtimes); setEngines(p.providers); })
      .catch(() => undefined).finally(() => setEnginesLoaded(true));
    fetchGpuDevices().then(setGpus).catch(() => undefined);
  }, []);
  // The installed launcher a safetensors download is for: the first one that
  // runs the format. Its vendor decides which cards the estimate counts.
  const serverRuntime = runtimes.find((r) => r.formats.includes('safetensors'));
  const serverEngines = engines.filter((e) => e.formats.includes('safetensors'));
  // Safetensors are searched for when an engine in the registry runs them,
  // installed or not, so a newcomer finds out what it would take. Both until
  // the registry has said otherwise: assuming GGUF while it loaded made the
  // line under the search box change as the page opened.
  const searchMode: CatalogSearch = !enginesLoaded || serverEngines.length > 0 ? 'all' : 'gguf';
  const format: CatalogFormat = pickedFormat ?? 'gguf';
  // Cards for the GGUF size warning: the smallest one, and how many there are.
  const cardGiB = gpus.length
    ? Math.min(...gpus.map((g) => (g.live?.memory_total_mib ?? VRAM_GIB * 1024) / 1024))
    : VRAM_GIB;
  const cardCount = Math.max(1, gpus.length);
  const [repos, setRepos] = useState<CatalogRepo[]>([]);
  // Reset on every search rather than remembered: a new query is a new set, and
  // landing on page 4 of it is never what was meant.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [filePage, setFilePage] = useState(1);
  const [filePageSize, setFilePageSize] = useState(10);
  const columnsRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const [files, setFiles] = useState<CatalogFile[]>([]);
  // Speed estimates, filled in one row at a time and never on load. Reading a
  // GGUF header costs a few MiB of transfer per file; a repo listing seventy-six
  // quants would pull half a gigabyte just to draw a column, so the estimate is
  // asked for rather than assumed.
  const [estimates, setEstimates] =
    useState<Record<string, FileEstimate | 'loading' | 'error'>>({});
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloads, setDownloads] = useState<DownloadStatus[]>([]);
  // Where downloads go: the GGUF default until somebody picks another. The
  // picker is there only when there is more than one place to pick.
  const [locations, setLocations] = useState<ModelLocation[]>([]);
  const [target, setTarget] = useState<string | undefined>(undefined);
  useEffect(() => {
    fetchModelLocations().then((l) => {
      setLocations(l.locations);
      setTarget((t) => t ?? l.locations.find((x) => x.default_for.includes('gguf'))?.key);
    }).catch(() => undefined);
  }, []);
  // Each format has its own default place; switching format switches to it.
  useEffect(() => {
    const found = locations.find((x) => x.default_for.includes(format))?.key;
    if (found) setTarget(found);
  }, [format, locations]);
  /** A name as an entry has it, with the location it is in spelt out. */
  const placed = (ref: string) => {
    const key = /^\$\{(models-dir-[2-5])\}\//.exec(ref)?.[1] ?? 'models-dir';
    const loc = locations.find((l) => l.key === key);
    return locations.length > 1 && loc
      ? `${locationName(loc)}：${withinLocation(ref)}`
      : withinLocation(ref);
  };
  // Finished rows stay until dismissed, so a download that ended while the user
  // was on another page is still reported when they come back.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  // Already-announced completions. Seeded from the first fetch, otherwise every
  // reload would toast for downloads that finished days ago.
  const announced = useRef<Set<string>>(new Set());
  // The stream can deliver a snapshot before that first fetch resolves. Until
  // it has, nothing is announced: a completion from days ago would otherwise
  // toast on every page load. The row still shows its state either way.
  const seeded = useRef(false);

  useEffect(() => {
    fetchDownloads().then((list) => {
      for (const d of list) if (d.state === 'done') announced.current.add(keyOf(d));
      setDownloads(list);
    }).catch(() => undefined).finally(() => { seeded.current = true; });
  }, []);

  useEffect(() => subscribe((event) => {
    if (event.type !== 'downloads') return;
    const list = event.data as DownloadStatus[];
    for (const d of list) {
      if (seeded.current && d.state === 'done' && !announced.current.has(keyOf(d))) {
        announced.current.add(keyOf(d));
        message.success(`${d.filename || d.repo_id} 下載完成`);
        // A folder that finished is the one on the right: show it as on disk.
        if (d.kind === 'folder' && d.repo_id === selectedRef.current) {
          catalogFolder(d.repo_id).then(setFolder).catch(() => undefined);
        }
      }
    }
    setDownloads(list);
  }), [message]);

  const onSearch = useCallback(async (value: string, as?: CatalogSearch) => {
    if (!value.trim()) return;
    setSearching(true);
    setSelected(null);
    setPickedFormat(null);
    setFiles([]);
    setFolder(null);
    setEstimates({});
    setPage(1);
    setPageSize(10);
    setFilePageSize(10);
    try {
      setRepos(await searchCatalog(value, as ?? searchMode));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSearching(false);
    }
  }, [message, searchMode]);

  // What the filter leaves, and how many each choice would leave.
  const listed = repos.filter((r) => formatFilter === 'all' || r.format === formatFilter);
  const countFormat = (f: 'all' | CatalogFormat) =>
    repos.filter((r) => f === 'all' || r.format === f).length;

  const onPick = async (repoId: string, as?: CatalogFormat) => {
    const picked: CatalogFormat = as
      ?? repos.find((r) => r.repo_id === repoId)?.format
      ?? 'gguf';
    setSelected(repoId);
    setPickedFormat(picked);
    selectedRef.current = repoId;
    setEstimates({});
    setFilePage(1);
    setFilePageSize(10);
    setLoadingFiles(true);
    setFiles([]);
    setFolder(null);
    setVariants(null);
    try {
      if (picked === 'safetensors') {
        // The other precisions come from a second, slower query; the folder
        // does not wait for them.
        catalogVariants(repoId).then((v) => {
          if (selectedRef.current === repoId) setVariants(v);
        }).catch(() => { if (selectedRef.current === repoId) setVariants([]); });
        setFolder(await catalogFolder(repoId));
      } else setFiles(await catalogFiles(repoId));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoadingFiles(false);
    }
  };

  /**
   * Every part, not just the first.
   *
   * A split model is only a model once all of it is here -- llama.cpp is
   * pointed at the first part and looks for the rest beside it, so fetching one
   * produces a file that loads as nothing. They are started together and appear
   * as separate rows below, which is honest: each is its own transfer and can
   * fail or be cancelled on its own.
   */
  const onDownload = async (file: CatalogFile) => {
    if (!selected) return;
    try {
      for (const part of file.parts) await startDownload(selected, part, target);
      message.success(file.part_count > 1
        ? `已開始下載 ${file.part_count} 個分片`
        : '已開始下載');
      setDownloads(await fetchDownloads());
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const onFolderDownload = async () => {
    if (!selected) return;
    try {
      await startFolderDownload(selected, target);
      message.success('已開始下載整個資料夾');
      setDownloads(await fetchDownloads());
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  /** To the model page, with a new entry for this folder filled in the way the
   *  estimate suggests: the launcher, the cards, and a quantisation if the
   *  published precision would leave no room. */
  const onCreate = (plan: Plan | undefined) => {
    if (!folder || !serverRuntime) return;
    navigate('/models', { state: { create: {
      runtime: serverRuntime.macro, model_file: folder.local_path, repo: folder.repo_id,
      cards: plan?.cards ?? 1, quantization: plan?.quantization ?? '',
      context: folder.context_length,
    } } });
  };

  const onEstimate = async (file: CatalogFile) => {
    if (!selected || estimates[file.filename]) return;
    setEstimates((prev) => ({ ...prev, [file.filename]: 'loading' }));
    try {
      const found = await estimateFile(selected, file.parts, file.size_bytes);
      setEstimates((prev) => ({ ...prev, [file.filename]: found }));
    } catch {
      setEstimates((prev) => ({ ...prev, [file.filename]: 'error' }));
    }
  };

  const shown = downloads.filter((d) => !dismissed.has(keyOf(d)));
  const running = shown.filter((d) => !ENDED.includes(d.state)).length;

  // Past every card together a GGUF does not fit even split; past one card it
  // needs the model split across more.
  const oversized = files.some((f) => f.size_gib >= cardGiB * cardCount * 0.9);
  // Both cards are given the same height and each pins its own paginator, so
  // their floors line up without anyone estimating what sits on them.
  const columnHeight = useFillToTrigger(columnsRef, 0, [shown.length > 0, repos.length]);
  // The table's scroll region is the rows alone; its header sits above them
  // inside the same box.
  const tableHeight = Math.max(120, useElementHeight(tableRef) - TABLE_HEAD);

  const dismiss = (d: DownloadStatus) =>
    setDismissed((prev) => new Set(prev).add(keyOf(d)));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {shown.length > 0 && (
        <Card title={running ? `下載中 (${running})` : '下載'} size="small">
          <List
            dataSource={shown}
            renderItem={(d) => {
              const view = STATE_VIEW[d.state] ?? STATE_VIEW.downloading;
              const ended = ENDED.includes(d.state);
              return (
                <List.Item
                  actions={[
                    ended ? (
                      <Button key="dismiss" size="small" type="text" icon={<CloseOutlined />}
                              onClick={() => dismiss(d)}>
                        關閉
                      </Button>
                    ) : (
                      <Button key="cancel" size="small" danger icon={<StopOutlined />}
                              onClick={() => cancelDownload(d.repo_id, d.filename)}>
                        取消
                      </Button>
                    ),
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space size={8}>
                        <span>{d.kind === 'folder' ? d.repo_id : d.filename}</span>
                        {d.kind === 'folder' && <Tag>整個資料夾</Tag>}
                        {view.tag && <Tag color={view.tag}>{view.label}</Tag>}
                        {d.state === 'verifying' && <Tag color="processing">驗證中</Tag>}
                      </Space>
                    }
                    description={
                      <div style={{ maxWidth: 640 }}>
                        {/* A finished download is pinned to 100: the last byte
                            lands between two progress ticks, so the final
                            reported figure is a rounding short of the end. */}
                        <Progress
                          percent={d.state === 'done' ? 100 : d.percent}
                          size="small"
                          status={view.status}
                        />
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {d.state === 'done'
                            ? `${(d.total_bytes / 1024 ** 3).toFixed(1)} GiB ・ ${d.repo_id}`
                            : d.state === 'error'
                              ? `${d.error || '下載失敗'} ・ ${d.repo_id}`
                              : `${(d.downloaded_bytes / 1024 ** 3).toFixed(1)} / `
                                + `${(d.total_bytes / 1024 ** 3).toFixed(1)} GiB `
                                + `・ ${d.mib_per_second} MiB/s`
                                + (d.kind === 'folder'
                                  ? ` ・ 第 ${Math.min((d.files_done ?? 0) + 1, d.files ?? 0)}/${d.files} 個檔案`
                                    + (d.current ? `：${d.current}` : '')
                                  : ` ・ ${d.repo_id}`)}
                        </Text>
                      </div>
                    }
                  />
                </List.Item>
              );
            }}
          />
        </Card>
      )}

      <Card size="small">
        <Input.Search
          placeholder="搜尋 Hugging Face 上的模型，例如 Qwen3.8-27B"

          enterButton="搜尋"
          size="large"
          loading={searching}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={(value) => void onSearch(value)}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {searchMode === 'gguf'
            ? '一個 GGUF 檔就是一個模型，給 llama.cpp 用：從右邊挑一個量化版本下載。'
            : '兩種格式一起列出，每筆標出是哪一種：GGUF 是挑一個檔案給 llama.cpp，safetensors 是整個資料夾給 vLLM 這類伺服器引擎。'}
        </Text>
        {formatFilter === 'safetensors' && serverEngines.length > 0 && !serverRuntime && (
          <Alert
            style={{ marginTop: 10 }}
            type="info"
            showIcon
            message={<>還沒有安裝能跑 safetensors 的推論引擎。先到 <Link to="/engines">推論引擎</Link> 安裝 {serverEngines.map((e) => e.name).join(' 或 ')}，下載的模型才有地方跑。</>}
          />
        )}
      </Card>

      {(repos.length > 0 || selected) && (
      <div
        ref={columnsRef}
        style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}
      >
      {repos.length > 0 && (
        <Card
          style={{ flex: '1 1 420px', minWidth: 0 }}
          // A definite height rather than a cap, so the rows can be given the
          // slack and the paginator can hold the floor of the card.
          styles={{ body: {
            height: columnHeight - CARD_HEAD, padding: 0,
            display: 'flex', flexDirection: 'column',
          } }}
          title={
            <Space size={8}>
              <span style={{ fontSize: 13 }}>搜尋結果</span>
              {/* A dropdown, like the model page's engine filter: it narrows
                  what the search found, and says how many each would leave. */}
              {searchMode === 'all' && (
                <Select
                  size="small"
                  value={formatFilter}
                  onChange={(v) => { setFormatFilter(v); setPage(1); }}
                  style={{ minWidth: 150, fontWeight: 400 }}
                  options={[
                    { value: 'all', label: `全部格式（${countFormat('all')}）` },
                    { value: 'gguf', label: `GGUF（${countFormat('gguf')}）` },
                    { value: 'safetensors', label: `Safetensors（${countFormat('safetensors')}）` },
                  ]}
                />
              )}
            </Space>
          }
          size="small"
          extra={
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              {listed.length} 個儲存庫
            </Text>
          }
        >
          {/* The paginator is a control on this list, not the last thing in
              it. Left to antd it renders after the items and scrolls away with
              them, so "第 41-50 筆" -- which is the answer to where you are --
              is only readable once you have already got to the bottom. The
              rows scroll inside their own box and it stays put beneath them. */}
          {/* No side padding here: a row's highlight and its divider run to
              the card's edges, and the row carries the inset itself. */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
          <List
            dataSource={listed.slice((page - 1) * pageSize, page * pageSize)}
            renderItem={(repo) => {
              const picked = selected === repo.repo_id;
              return (
                <List.Item
                  onClick={() => onPick(repo.repo_id)}
                  style={{
                    cursor: 'pointer',
                    // A left edge rather than a filled row: the fill washed out
                    // the tags sitting on it, and the only thing that needs
                    // saying is which one the file list below belongs to.
                    borderInlineStart: `2px solid ${picked ? '#6ea8fe' : 'transparent'}`,
                    background: picked ? 'rgba(110,168,254,0.06)' : undefined,
                    paddingInline: 22,
                  }}
                >
                  <List.Item.Meta
                    title={<Slide style={{ fontFamily: MONO, fontSize: 13 }}>{repo.repo_id}</Slide>}
                    description={
                      <Space size={6} wrap>
                        <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO }}>
                          ↓ {repo.downloads.toLocaleString()}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>♥ {repo.likes}</Text>
                        {searchMode === 'all' && repo.format && (
                          <Tag color={repo.format === 'gguf' ? 'cyan' : 'geekblue'} style={{ fontSize: 11 }}>
                            {repo.format === 'gguf' ? 'GGUF' : 'Safetensors'}
                          </Tag>
                        )}
                        {repo.gated && (
                          <Tooltip title="要先在 Hugging Face 同意使用條款，並在設定填入 token 才能下載">
                            <Tag color="gold" style={{ fontSize: 11 }}>需要授權</Tag>
                          </Tooltip>
                        )}
                        {repo.last_modified && (
                          <Text type="secondary" style={{ fontSize: 12, opacity: 0.7 }}>
                            ・ {since(repo.last_modified)}
                          </Text>
                        )}
                        {/* Nothing else: the Hub's own tags -- papers, task
                            names, licences, endpoint flags -- do not help
                            choose, and what a model can do is on the right,
                            read from its config rather than from how its
                            publisher filed it. */}
                      </Space>
                    }
                  />
                </List.Item>
              );
            }}
          />
          </div>

          <div style={{
            flexShrink: 0, borderTop: `1px solid ${LINE.faint}`,
            padding: '8px 12px', display: 'flex', justifyContent: 'center',
          }}>
            <Pagination
              current={page}
              pageSize={pageSize}
              total={listed.length}
              onChange={(p, size) => { setPage(p); setPageSize(size); }}
              showSizeChanger={sizeChanger(listed.length)}
              showTotal={pageTotal}
              size="small"
            />
          </div>
        </Card>
      )}

      <Card
        style={{ flex: '1 1 480px', minWidth: 0 }}
        size="small"
        loading={loadingFiles}
        styles={{ body: {
          height: columnHeight - CARD_HEAD, padding: 0,
          display: 'flex', flexDirection: 'column',
        } }}
        title={
          selected
            ? <Slide style={{ fontSize: 13, fontFamily: MONO }}>{selected}</Slide>
            : <span style={{ fontSize: 13 }}>{format === 'gguf' ? '檔案' : '模型資料夾'}</span>
        }
        extra={locations.length > 1 && (
          <Space size={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>下載到</Text>
            <Select
              size="small"
              style={{ width: 'min(180px, 36vw)' }}
              value={target}
              onChange={setTarget}
              options={locations.map((l) => ({
                value: l.key,
                label: locationName(l),
                title: `${l.path}（剩 ${(l.free_bytes / 1024 ** 3).toFixed(0)} GiB）`,
              }))}
            />
          </Space>
        )}
      >
        {!selected ? (
          <Empty description="從左邊選一個儲存庫" image={Empty.PRESENTED_IMAGE_SIMPLE}
                 style={{ margin: 'auto' }} />
        ) : format === 'safetensors' ? (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {folder && (
              <CatalogFolderPanel
                folder={folder}
                runtime={serverRuntime}
                gpus={gpus}
                placed={placed}
                download={downloads.find((d) => d.kind === 'folder' && d.repo_id === folder.repo_id)}
                onDownload={onFolderDownload}
                onCreate={onCreate}
                variants={variants}
                onPickVariant={(repo) => void onPick(repo, 'safetensors')}
              />
            )}
          </div>
        ) : (
          <>
          <div ref={tableRef} style={{ flex: 1, overflow: 'hidden', padding: '0 12px' }}>
          {files.length === 0 && !loadingFiles ? (
            <Empty description="這個儲存庫沒有 GGUF 檔" />
          ) : (
            <Table<CatalogFile>
              dataSource={files.slice((filePage - 1) * filePageSize, filePage * filePageSize)}
              rowKey="filename"
              size="small"
              // The rows scroll; the header stays with them, the paginator does
              // not -- it is pinned to the floor of the card below.
              scroll={{ y: tableHeight }}
              pagination={false}
              columns={[
                {
                  title: '檔名',
                  dataIndex: 'filename',
                  render: (name: string, row) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <Slide style={{ fontSize: 12, fontFamily: MONO, flex: 1, minWidth: 0 }}>
                        {name}
                      </Slide>
                      {row.part_count > 1 && (
                        <Tag style={{ flex: 'none' }}>{row.part_count} 分片</Tag>
                      )}
                      {row.is_mmproj && <Tag color="purple" style={{ flex: 'none' }}>視覺投影</Tag>}
                      {row.on_disk && (
                        <Tooltip title={placed(row.local_path)}>
                          <Tag color="green" style={{ flex: 'none' }}>已在磁碟</Tag>
                        </Tooltip>
                      )}
                      {!row.on_disk && row.elsewhere.length > 0 && (
                        /* Not a warning. The files no longer collide -- each
                           repo has its own directory -- so this only says that
                           a file of this name is already here from somewhere
                           else, which is sometimes exactly what you are
                           checking and sometimes a download you can skip. */
                        <Tooltip
                          title={<>已有同名檔案：<br />{row.elsewhere.map(placed).join('，')}</>}
                        >
                          <Tag color="default" style={{ flex: 'none' }}>另有同名</Tag>
                        </Tooltip>
                      )}
                    </div>
                  ),
                },
                {
                  title: '大小', dataIndex: 'size_gib', width: 150,
                  render: (gib: number) => (
                    <Space size={4}>
                      <span>{gib} GiB</span>
                      {gib >= cardGiB * cardCount * 0.9 && !Number.isNaN(gib) ? (
                        <Tag color="warning">超出顯存</Tag>
                      ) : gib >= cardGiB * 0.9 && !Number.isNaN(gib) && (
                        <Tooltip title="單張卡放不下，把模型分到多張卡（在「模型」頁選多張卡）就放得下">
                          <Tag color="blue">需 {Math.ceil(gib / (cardGiB * 0.9))} 張卡</Tag>
                        </Tooltip>
                      )}
                    </Space>
                  ),
                },
                {
                  title: '預估速度', width: 168, responsive: ['xl'],
                  render: (_, row) => {
                    // A projector has no decode loop of its own; the number
                    // would be meaningless rather than merely uncertain.
                    if (row.is_mmproj) return <Text type="secondary">—</Text>;
                    const found = estimates[row.filename];
                    if (!found) {
                      return (
                        <Tooltip title="讀這個檔案開頭約 8 MiB 的 GGUF 標頭來推算，不會下載模型">
                          <Button size="small" type="link" style={{ padding: 0 }}
                                  onClick={() => onEstimate(row)}>
                            估算
                          </Button>
                        </Tooltip>
                      );
                    }
                    if (found === 'loading') {
                      return <Text type="secondary">讀取標頭…</Text>;
                    }
                    if (found === 'error') {
                      return (
                        <Tooltip title="讀不到這個檔案的 GGUF 標頭">
                          <Text type="secondary">讀不到</Text>
                        </Tooltip>
                      );
                    }
                    return (
                      <Tooltip title={<EstimateDetail file={found} />}>
                        <Space size={4}>
                          <span style={{ fontFamily: MONO }}>{found.estimate.tok_s} tok/s</span>
                          <Tag color={CONFIDENCE[found.estimate.confidence].color}>
                            {CONFIDENCE[found.estimate.confidence].label}
                          </Tag>
                        </Space>
                      </Tooltip>
                    );
                  },
                },
                {
                  title: '', width: 110,
                  render: (_, row) => (
                    <Button size="small" icon={<CloudDownloadOutlined />}
                            disabled={row.on_disk}
                            onClick={() => onDownload(row)}>
                      下載
                    </Button>
                  ),
                },
              ]}
            />
          )}
          </div>

          <div style={{
            flexShrink: 0, borderTop: `1px solid ${LINE.faint}`, padding: '8px 12px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Pagination
                current={filePage}
                pageSize={filePageSize}
                total={files.length}
                onChange={(p, size) => { setFilePage(p); setFilePageSize(size); }}
                showSizeChanger={sizeChanger(files.length)}
                showTotal={pageTotal}
                size="small"
              />
            </div>
            {/* Only when something in this repo actually is oversized. It
                explains a workaround, and a workaround with nothing to work
                around is just a paragraph in the way. */}
            {oversized && (
              <Text type="secondary" style={{
                display: 'block', marginTop: 8, fontSize: 11, lineHeight: 1.6, opacity: 0.6,
              }}>
                <InfoCircleOutlined style={{ marginInlineEnd: 6 }} />
                超出顯存仍可執行：MoE 模型用 <code>--n-cpu-moe N</code> 把專家層放到主記憶體，
                只留注意力層在 GPU，在「模型」頁的額外參數設定。
              </Text>
            )}
          </div>
          </>
        )}
      </Card>
      </div>
      )}
    </Space>
  );
}
