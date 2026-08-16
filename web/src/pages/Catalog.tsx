import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Empty, Input, List, Progress, Space, Table, Tag, Typography,
} from 'antd';
import { CloseOutlined, CloudDownloadOutlined, StopOutlined } from '@ant-design/icons';
import { MONO } from '../theme';
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

  const onDownload = async (filename: string) => {
    if (!selected) return;
    try {
      await startDownload(selected, filename);
      message.success('已開始下載');
      setDownloads(await fetchDownloads());
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const shown = downloads.filter((d) => !dismissed.has(keyOf(d)));
  const running = shown.filter((d) => !ENDED.includes(d.state)).length;

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

      {repos.length > 0 && (
        <Card
          title={<span style={{ fontSize: 13 }}>搜尋結果</span>}
          size="small"
          extra={
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
              {repos.length} 個儲存庫
            </Text>
          }
        >
          <List
            dataSource={repos}
            pagination={{
              current: page,
              pageSize,
              total: repos.length,
              onChange: (p, size) => { setPage(p); setPageSize(size); },
              showSizeChanger: { options: sizeOptions(repos.length) },
              showTotal: pageTotal,
              size: 'small',
              align: 'center',
              hideOnSinglePage: false,
            }}
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
                    title={<span style={{ fontFamily: MONO, fontSize: 13 }}>{repo.repo_id}</span>}
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
        </Card>
      )}

      {selected && (
        <Card title={`${selected} 的檔案`} size="small" loading={loadingFiles}>
          {files.length === 0 && !loadingFiles ? (
            <Empty description="這個儲存庫沒有 GGUF 檔" />
          ) : (
            <Table<CatalogFile>
              dataSource={files}
              rowKey="filename"
              size="small"
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
                    <Space>
                      <span>{name}</span>
                      {row.is_mmproj && <Tag color="purple">視覺投影</Tag>}
                      {row.on_disk && <Tag color="green">已在磁碟</Tag>}
                    </Space>
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
                            onClick={() => onDownload(row.filename)}>
                      下載
                    </Button>
                  ),
                },
              ]}
            />
          )}
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message="超出顯存的模型仍然可以跑"
            description={
              <span>
                MoE 模型可用 <code>--n-cpu-moe N</code> 把專家層放到主記憶體，
                只有注意力層留在 GPU。速度會下降，但每個 token 只啟用少數專家，
                代價比整個模型搬到 CPU 小得多。在「模型」頁的額外參數欄位設定。
              </span>
            }
          />
        </Card>
      )}
    </Space>
  );
}
