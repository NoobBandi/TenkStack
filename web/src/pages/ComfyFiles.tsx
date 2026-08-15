import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Breadcrumb, Button, Card, Dropdown, Empty, Input, Modal,
  Popconfirm, Progress, Segmented, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, DownOutlined, FolderAddOutlined, FolderOutlined,
  PlusOutlined, StopOutlined, UploadOutlined,
} from '@ant-design/icons';
import {
  createComfyFolder, deleteComfyFile, fetchComfyFileRoots, fetchComfyLocation,
  uploadComfyFile,
  type ComfyFile, type ComfyFileRoot, type ComfyFolder,
} from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

/**
 * ComfyUI's model, input and output folders.
 *
 * Its own interface can list what it found but has no way to be given anything:
 * /upload takes an input image under 100 MB, so getting a checkpoint onto this
 * machine has meant a shell. This is that.
 *
 * Locations are paths rather than a flat list of folder names. ComfyUI's layout
 * looked flat by convention until the first video landed in `output/video/` --
 * SaveVideo's default prefix nests, and model folders take subdirectories too.
 *
 * Kept off the ComfyUI page on purpose. That page answers whether the thing is
 * running and takes you to it; this is a workspace, and folding them together
 * would cost the first one the quality that makes it useful.
 */

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

interface Transfer {
  id: string;
  name: string;
  size: number;
  sent: number;
  error?: string;
  abort: AbortController;
}

export default function ComfyFiles() {
  const { message } = AntApp.useApp();
  const [roots, setRoots] = useState<ComfyFileRoot[]>([]);
  const [root, setRoot] = useState('models');
  const [path, setPath] = useState('');
  const [folders, setFolders] = useState<ComfyFolder[]>([]);
  const [files, setFiles] = useState<ComfyFile[]>([]);
  const [writable, setWritable] = useState(false);
  const [free, setFree] = useState(0);
  const [loading, setLoading] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  // Uploads outlive a navigation step, so the queue is keyed by its own id
  // rather than by whatever is on screen.
  const nextId = useRef(0);
  const picker = useRef<HTMLInputElement>(null);

  const activeRoot = roots.find((r) => r.key === root);
  const segments = path ? path.split('/') : [];

  const load = useCallback(async (key: string, at: string) => {
    setLoading(true);
    try {
      const data = await fetchComfyLocation(key, at);
      setFolders(data.folders);
      setFiles(data.files);
      setWritable(data.writable);
      setFree(data.free);
    } catch (error) {
      message.error((error as Error).message);
      setFolders([]);
      setFiles([]);
      setWritable(false);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    fetchComfyFileRoots().then((d) => setRoots(d.roots)).catch(() => undefined);
  }, []);
  useEffect(() => { void load(root, path); }, [root, path, load]);

  const go = (key: string, at: string) => {
    if (key !== root) setRoot(key);
    setPath(at);
  };

  const patch = (id: string, change: Partial<Transfer>) =>
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...change } : t)));

  const startUpload = (file: File) => {
    if (file.size > free) {
      // Refused here rather than after twenty minutes of transfer.
      message.error(`空間不足：這個檔案 ${bytes(file.size)}，磁碟剩 ${bytes(free)}`);
      return;
    }

    const id = `u${nextId.current++}`;
    const abort = new AbortController();
    const at = path;
    const where = root;
    setTransfers((prev) => [...prev, { id, name: file.name, size: file.size, sent: 0, abort }]);

    uploadComfyFile(where, at, file, (sent) => patch(id, { sent }), abort.signal)
      .then(() => {
        setTransfers((prev) => prev.filter((t) => t.id !== id));
        message.success(`${file.name} 已上傳`);
        if (where === root && at === path) void load(root, path);
      })
      .catch((error: Error) => {
        // Kept in the list rather than cleared: the bytes are still on disk as a
        // .part, so dropping the row would hide something that exists and can be
        // resumed by choosing the same file again.
        patch(id, { error: error.name === 'AbortError' ? '已取消' : error.message });
      });
  };

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(event.target.files ?? []).forEach(startUpload);
    // Cleared so choosing the same file twice fires change again, which is how
    // a failed upload is retried.
    event.target.value = '';
  };

  const onCreateFolder = async () => {
    const name = (newFolder ?? '').trim();
    if (!name) return;
    try {
      await createComfyFolder(root, path, name);
      setNewFolder(null);
      void load(root, path);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const onDelete = async (file: ComfyFile) => {
    try {
      const { freed } = await deleteComfyFile(root, path, file.name, file.partial);
      message.success(freed ? `已刪除，釋出 ${bytes(freed)}` : '已刪除');
      void load(root, path);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <input
        ref={picker} type="file" multiple hidden onChange={onPick}
      />

      {activeRoot && !activeRoot.writable && (
        <Alert
          type="warning"
          showIcon
          message="這個目錄主控台寫不進去"
          description={
            <span>
              <code>{activeRoot.path}</code> 是容器以 root 身分建立的，而主控台不是 root。
              一次性修好（不需要 sudo，透過容器本身即可）：
              <br />
              <code style={{ fontSize: 11 }}>
                docker exec comfyui-xpu find /root/ComfyUI/models /root/ComfyUI/input
                /root/ComfyUI/output -type d -exec chown 1000:1000 {'{}'} +
              </code>
            </span>
          }
        />
      )}

      <Card size="small" styles={{ body: { padding: 12 } }}>
        <Space size={16} wrap style={{ width: '100%' }}>
          <Segmented
            size="small"
            value={root}
            onChange={(v) => go(v as string, '')}
            options={roots.map((r) => ({ label: r.label, value: r.key }))}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>{activeRoot?.note}</Text>
          <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.5, marginLeft: 'auto' }}>
            磁碟可用 {bytes(free)}
          </Text>
        </Space>
      </Card>

      <Card
        size="small"
        title={
          <Breadcrumb
            style={{ fontSize: 12, fontFamily: MONO }}
            items={[
              {
                title: <a onClick={() => setPath('')}>{activeRoot?.label ?? root}</a>,
              },
              ...segments.map((segment, i) => ({
                title: i === segments.length - 1
                  ? <span>{segment}</span>
                  : <a onClick={() => setPath(segments.slice(0, i + 1).join('/'))}>{segment}</a>,
              })),
            ]}
          />
        }
        extra={
          <Space size={8}>
            <Dropdown
              disabled={!writable}
              menu={{
                items: [
                  {
                    key: 'upload',
                    label: '上傳檔案',
                    icon: <UploadOutlined />,
                    onClick: () => picker.current?.click(),
                  },
                  {
                    key: 'folder',
                    label: '新增資料夾',
                    icon: <FolderAddOutlined />,
                    onClick: () => setNewFolder(''),
                  },
                ],
              }}
            >
              <Button size="small" type="primary" ghost icon={<PlusOutlined />}>
                新建 <DownOutlined style={{ fontSize: 9 }} />
              </Button>
            </Dropdown>
            <Button size="small" onClick={() => void load(root, path)}>重新整理</Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {/* The drop target is the whole panel rather than a separate box: with
              folders and files already filling it, a dedicated dragger would be
              a third region competing for the same space. */}
          <div
            onDragOver={(e) => { if (writable) e.preventDefault(); }}
            onDrop={(e) => {
              if (!writable) return;
              e.preventDefault();
              Array.from(e.dataTransfer.files).forEach(startUpload);
            }}
            style={{ minHeight: 120 }}
          >
            {transfers.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <Text style={{ fontSize: 12, fontFamily: MONO, flex: '0 1 240px' }} ellipsis>
                  {t.name}
                </Text>
                <Progress
                  percent={Math.floor((t.sent / Math.max(t.size, 1)) * 100)}
                  size="small"
                  status={t.error ? 'exception' : 'active'}
                  style={{ flex: 1, margin: 0 }}
                />
                <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
                  {bytes(t.sent)} / {bytes(t.size)}
                </Text>
                {t.error ? (
                  <Tooltip title={t.error}>
                    <Button
                      size="small" type="text"
                      onClick={() => setTransfers((p) => p.filter((x) => x.id !== t.id))}
                    >
                      關閉
                    </Button>
                  </Tooltip>
                ) : (
                  <Button size="small" type="text" icon={<StopOutlined />}
                          onClick={() => t.abort.abort()} />
                )}
              </div>
            ))}

            <Table<ComfyFolder | ComfyFile>
              size="small"
              loading={loading}
              dataSource={[...folders, ...files]}
              rowKey={(row) => ('files' in row ? `d:${row.name}` : `f:${row.name}`)}
              pagination={false}
              scroll={{ y: 460 }}
              locale={{
                emptyText: (
                  <Empty
                    description={writable ? '空的 — 拖檔案進來，或用右上角的「新建」' : '空的'}
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                ),
              }}
              columns={[
                {
                  title: '名稱',
                  render: (_, row) => {
                    const dir = 'files' in row;
                    return (
                      <Space size={7}>
                        {dir
                          ? <FolderOutlined style={{ fontSize: 11, opacity: 0.5 }} />
                          : <span style={{ display: 'inline-block', width: 11 }} />}
                        {dir ? (
                          <a
                            style={{ fontSize: 12, fontFamily: MONO }}
                            onClick={() => setPath(path ? `${path}/${row.name}` : row.name)}
                          >
                            {row.name}
                          </a>
                        ) : (
                          <Text style={{ fontSize: 12, fontFamily: MONO }}>{row.name}</Text>
                        )}
                        {!dir && (row as ComfyFile).partial && (
                          <Tag color="gold" style={{ fontSize: 10 }}>未完成</Tag>
                        )}
                      </Space>
                    );
                  },
                },
                {
                  title: '大小',
                  width: 120,
                  align: 'right',
                  render: (_, row) => (
                    <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.65 }}>
                      {'files' in row
                        ? (row.files ? `${row.files} 項 ・ ${bytes(row.size)}` : '空')
                        : bytes((row as ComfyFile).size)}
                    </Text>
                  ),
                },
                {
                  title: '修改時間',
                  width: 130,
                  align: 'right',
                  render: (_, row) => (
                    <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.45 }}>
                      {'files' in row ? '' : when((row as ComfyFile).modified)}
                    </Text>
                  ),
                },
                {
                  title: '',
                  width: 44,
                  align: 'right',
                  render: (_, row) => (
                    <Popconfirm
                      title={`刪除 ${row.name}？`}
                      description={'files' in row ? '資料夾必須是空的' : undefined}
                      okText="刪除" cancelText="取消" okButtonProps={{ danger: true }}
                      onConfirm={() => void onDelete(row as ComfyFile)}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />}
                              disabled={!writable} />
                    </Popconfirm>
                  ),
                },
              ]}
            />
          </div>
        </Space>
      </Card>

      <Modal
        open={newFolder !== null}
        title="新增資料夾"
        okText="建立" cancelText="取消"
        onOk={() => void onCreateFolder()}
        onCancel={() => setNewFolder(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={newFolder ?? ''}
          placeholder="資料夾名稱"
          onChange={(e) => setNewFolder(e.target.value)}
          onPressEnter={() => void onCreateFolder()}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          建立在 {activeRoot?.label}{path ? ` / ${path}` : ''} 底下
        </Text>
      </Modal>
    </Space>
  );
}
