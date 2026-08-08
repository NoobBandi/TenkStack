import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Empty, Input, List, Progress, Space, Table, Tag, Typography,
} from 'antd';
import { CloudDownloadOutlined, StopOutlined } from '@ant-design/icons';
import {
  cancelDownload, catalogFiles, fetchDownloads, searchCatalog, startDownload, subscribe,
  type CatalogFile, type CatalogRepo, type DownloadStatus,
} from '../api';

const { Text } = Typography;

/** The card holds 32 GiB. Anything at or above this cannot be fully resident,
 *  so the UI says so before the download rather than after. */
const VRAM_GIB = 32;

export default function Catalog() {
  const { message } = AntApp.useApp();
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<CatalogRepo[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<CatalogFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloads, setDownloads] = useState<DownloadStatus[]>([]);

  useEffect(() => { fetchDownloads().then(setDownloads).catch(() => undefined); }, []);

  // Progress is pushed only while something is actually downloading.
  useEffect(() => subscribe((event) => {
    if (event.type === 'downloads') setDownloads(event.data as DownloadStatus[]);
  }), []);

  const onSearch = useCallback(async (value: string) => {
    if (!value.trim()) return;
    setSearching(true);
    setSelected(null);
    setFiles([]);
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

  const active = downloads.filter((d) => d.state === 'downloading' || d.state === 'queued');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {active.length > 0 && (
        <Card title="下載中" size="small">
          <List
            dataSource={active}
            renderItem={(d) => (
              <List.Item
                actions={[
                  <Button key="cancel" size="small" danger icon={<StopOutlined />}
                          onClick={() => cancelDownload(d.repo_id, d.filename)}>
                    取消
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={d.filename}
                  description={
                    <div style={{ maxWidth: 640 }}>
                      <Progress percent={d.percent} size="small" status="active" />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {(d.downloaded_bytes / 1024 ** 3).toFixed(1)} /{' '}
                        {(d.total_bytes / 1024 ** 3).toFixed(1)} GiB ・ {d.mib_per_second} MiB/s
                        ・ {d.repo_id}
                      </Text>
                    </div>
                  }
                />
              </List.Item>
            )}
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
        <Card title="搜尋結果" size="small">
          <List
            dataSource={repos}
            renderItem={(repo) => (
              <List.Item
                onClick={() => onPick(repo.repo_id)}
                style={{
                  cursor: 'pointer',
                  background: selected === repo.repo_id ? 'rgba(22,119,255,0.08)' : undefined,
                  paddingInline: 8,
                }}
              >
                <List.Item.Meta
                  title={repo.repo_id}
                  description={
                    <Space size={4} wrap>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        ↓ {repo.downloads.toLocaleString()} ・ ♥ {repo.likes}
                      </Text>
                      {repo.tags.slice(0, 5).map((t) => (
                        <Tag key={t} style={{ fontSize: 11 }}>{t}</Tag>
                      ))}
                    </Space>
                  }
                />
              </List.Item>
            )}
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
              pagination={false}
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
