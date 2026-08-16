import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  App as AntApp, Button, Card, Empty, Input, List, Pagination, Progress, Space, Table,
  Tag, Typography,
} from 'antd';
import {
  CloseOutlined, CloudDownloadOutlined, InfoCircleOutlined, StopOutlined,
} from '@ant-design/icons';
import { LINE, MONO } from '../theme';
import {
  cancelDownload, catalogFiles, fetchDownloads, searchCatalog, startDownload, subscribe,
  type CatalogFile, type CatalogRepo, type DownloadStatus,
} from '../api';

const { Text } = Typography;

/** The card holds 32 GiB. Anything at or above this cannot be fully resident,
 *  so the UI says so before the download rather than after. */
const VRAM_GIB = 32;

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

/** Locale for every paginator here, so "第 1-10 筆，共 100 筆" reads the same. */
const pageTotal = (total: number, range: [number, number]) =>
  `第 ${range[0]}-${range[1]} 筆，共 ${total} 筆`;

/** antd fixes the sidebar's collapse trigger over the bottom of the window.
 *  Its top edge is the line everything here stops at. */
const TRIGGER_TOP = 48;

/** A small Card's header, which sits above the body being sized. */
const CARD_HEAD = 39;

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
  const [filePageSize, setFilePageSize] = useState(10);
  const columnsRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<CatalogFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloads, setDownloads] = useState<DownloadStatus[]>([]);
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
      for (const part of file.parts) await startDownload(selected, part);
      message.success(file.part_count > 1
        ? `已開始下載 ${file.part_count} 個分片`
        : '已開始下載');
      setDownloads(await fetchDownloads());
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const shown = downloads.filter((d) => !dismissed.has(keyOf(d)));
  const running = shown.filter((d) => !ENDED.includes(d.state)).length;

  const oversized = files.some((f) => f.size_gib >= VRAM_GIB * 0.9);
  // Both panels stop at the same line. The left one is a scrolling body, so it
  // takes the whole distance; the table's scroll region is only the rows, so
  // the paginator and the footnote under it have to be left out of the number.
  const columnHeight = useFillToTrigger(columnsRef, 0, [shown.length > 0, repos.length]);
  const tableHeight = useFillToTrigger(
    tableRef,
    (files.length > 10 ? 56 : 0) + (oversized ? 34 : 0),
    [shown.length > 0, selected, files.length, filePageSize, oversized],
  );

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
              showSizeChanger={{ options: sizeOptions(repos.length) }}
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
        title={
          selected
            ? <Slide style={{ fontSize: 13, fontFamily: MONO }}>{selected}</Slide>
            : <span style={{ fontSize: 13 }}>檔案</span>
        }
      >
        {!selected ? (
          <Empty description="從左邊選一個儲存庫" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
          <div ref={tableRef}>
          {files.length === 0 && !loadingFiles ? (
            <Empty description="這個儲存庫沒有 GGUF 檔" />
          ) : (
            <Table<CatalogFile>
              dataSource={files}
              rowKey="filename"
              size="small"
              // The rows scroll, the header and the paginator do not.
              scroll={{ y: tableHeight }}
              pagination={files.length > 10 ? {
                pageSize: filePageSize,
                onChange: (_, size) => setFilePageSize(size),
                showSizeChanger: { options: sizeOptions(files.length) },
                showTotal: pageTotal,
                size: 'small',
                align: 'center',
              } : false}
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
                      {row.on_disk && <Tag color="green" style={{ flex: 'none' }}>已在磁碟</Tag>}
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
          {/* Only when something in this repo actually is oversized. It
              explains a workaround, and a workaround with nothing to work
              around is just a paragraph in the way. */}
          </div>
          {oversized && (
            <Text type="secondary" style={{
              display: 'block', marginTop: 10, fontSize: 11, lineHeight: 1.6, opacity: 0.6,
            }}>
              <InfoCircleOutlined style={{ marginInlineEnd: 6 }} />
              超出顯存仍可執行：MoE 模型用 <code>--n-cpu-moe N</code> 把專家層放到主記憶體，
              只留注意力層在 GPU，在「模型」頁的額外參數設定。
            </Text>
          )}
          </>
        )}
      </Card>
      </div>
      )}
    </Space>
  );
}
