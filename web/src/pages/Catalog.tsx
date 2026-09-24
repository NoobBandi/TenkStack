import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  App as AntApp, Button, Card, Empty, Input, List, Pagination, Progress, Select, Space, Table,
  Tag, Tooltip, Typography,
} from 'antd';
import {
  CloseOutlined, CloudDownloadOutlined, InfoCircleOutlined, StopOutlined,
} from '@ant-design/icons';
import { LINE, MONO } from '../theme';
import {
  cancelDownload, catalogFiles, estimateFile, fetchDownloads, fetchModelLocations, locationName,
  searchCatalog, startDownload, subscribe, withinLocation,
  type CatalogFile, type CatalogRepo, type DownloadStatus, type FileEstimate, type ModelLocation,
} from '../api';

const { Text } = Typography;

/** The card holds 32 GiB. Anything at or above this cannot be fully resident,
 *  so the UI says so before the download rather than after. */
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
  done: { status: 'success', label: '完成', tag: 'success' },
  error: { status: 'exception', label: '失敗', tag: 'error' },
  cancelled: { status: 'normal', label: '已取消' },
};

export default function Catalog() {
  const { message } = AntApp.useApp();
  const [query, setQuery] = useState('');
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
        message.success(`${d.filename} 下載完成`);
      }
    }
    setDownloads(list);
  }), [message]);

  const onSearch = useCallback(async (value: string) => {
    if (!value.trim()) return;
    setSearching(true);
    setSelected(null);
    setFiles([]);
    setEstimates({});
    setPage(1);
    setPageSize(10);
    setFilePageSize(10);
    try {
      setRepos(await searchCatalog(value));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSearching(false);
    }
  }, [message]);

  const onPick = async (repoId: string) => {
    setSelected(repoId);
    setEstimates({});
    setFilePage(1);
    setFilePageSize(10);
    setLoadingFiles(true);
    try {
      setFiles(await catalogFiles(repoId));
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

  const oversized = files.some((f) => f.size_gib >= VRAM_GIB * 0.9);
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
                        <span>{d.filename}</span>
                        {view.tag && <Tag color={view.tag}>{view.label}</Tag>}
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
                                + `・ ${d.mib_per_second} MiB/s ・ ${d.repo_id}`}
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
          placeholder="搜尋 Hugging Face 上的 GGUF 模型，例如 qwen3 coder"
          enterButton="搜尋"
          size="large"
          loading={searching}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={onSearch}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          只列出 GGUF 儲存庫——這台機器的推論後端是 llama.cpp，其他格式無法執行。
        </Text>
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
          title={<span style={{ fontSize: 13 }}>搜尋結果</span>}
          size="small"
          extra={
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              {repos.length} 個儲存庫
            </Text>
          }
        >
          {/* The paginator is a control on this list, not the last thing in
              it. Left to antd it renders after the items and scrolls away with
              them, so "第 41-50 筆" -- which is the answer to where you are --
              is only readable once you have already got to the bottom. The
              rows scroll inside their own box and it stays put beneath them. */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px' }}>
          <List
            dataSource={repos.slice((page - 1) * pageSize, page * pageSize)}
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
                    paddingInline: 10,
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
                        {repo.last_modified && (
                          <Text type="secondary" style={{ fontSize: 12, opacity: 0.7 }}>
                            ・ {since(repo.last_modified)}
                          </Text>
                        )}
                        {/* Tags that every GGUF repo carries say nothing about
                            this one. */}
                        {repo.tags
                          .filter((t) => !['gguf', 'transformers', 'text-generation'].includes(t))
                          .slice(0, 4)
                          .map((t) => (
                            <Tag key={t} style={{ fontSize: 11 }}>{t}</Tag>
                          ))}
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
              total={repos.length}
              onChange={(p, size) => { setPage(p); setPageSize(size); }}
              showSizeChanger={sizeChanger(repos.length)}
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
            : <span style={{ fontSize: 13 }}>檔案</span>
        }
        extra={locations.length > 1 && (
          <Space size={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>下載到</Text>
            <Select
              size="small"
              style={{ width: 180 }}
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
                      {gib >= VRAM_GIB * 0.9 && !Number.isNaN(gib) && (
                        <Tag color="warning">超出顯存</Tag>
                      )}
                    </Space>
                  ),
                },
                {
                  title: '預估速度', width: 168,
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
