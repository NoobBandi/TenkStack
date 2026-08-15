import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Empty, Popconfirm, Progress, Segmented,
  Space, Table, Tag, Tooltip, Typography, Upload,
} from 'antd';
import {
  DeleteOutlined, FolderOutlined, InboxOutlined, StopOutlined,
} from '@ant-design/icons';
import {
  deleteComfyFile, fetchComfyFileRoots, fetchComfyFiles, fetchComfyFolders,
  uploadComfyFile,
  type ComfyFile, type ComfyFileRoot, type ComfyFolder,
} from '../api';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * ComfyUI's model and input folders.
 *
 * Its own interface can list what it found but has no way to be given anything:
 * /upload takes an input image under 100 MB, so getting a checkpoint onto this
 * machine has meant a shell. This is that, with the folder layout ComfyUI
 * already expects rather than a general file browser -- the whole question is
 * "does this land somewhere ComfyUI will look", and a free-form path is the one
 * way to get that wrong.
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
  const [folders, setFolders] = useState<ComfyFolder[]>([]);
  const [free, setFree] = useState(0);
  const [folder, setFolder] = useState('');
  const [files, setFiles] = useState<ComfyFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  // Uploads outlive a folder change, so the queue is keyed by its own id rather
  // than by whatever is on screen.
  const nextId = useRef(0);

  const activeRoot = roots.find((r) => r.key === root);

  const loadFolders = useCallback(async (key: string) => {
    try {
      const data = await fetchComfyFolders(key);
      setFolders(data.folders);
      setFree(data.free);
      setFolder((prev) => (data.folders.some((f) => f.name === prev) ? prev : ''));
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [message]);

  const loadFiles = useCallback(async (key: string, name: string) => {
    if (!name) { setFiles([]); return; }
    setLoading(true);
    try {
      setFiles((await fetchComfyFiles(key, name)).files);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    fetchComfyFileRoots().then((d) => setRoots(d.roots)).catch(() => undefined);
  }, []);
  useEffect(() => { void loadFolders(root); }, [root, loadFolders]);
  useEffect(() => { void loadFiles(root, folder); }, [root, folder, loadFiles]);

  const patch = (id: string, change: Partial<Transfer>) =>
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...change } : t)));

  const startUpload = (file: File) => {
    if (!folder) { message.warning('先選一個資料夾'); return; }
    if (file.size > free) {
      // Refused here rather than after twenty minutes of transfer.
      message.error(`空間不足：這個檔案 ${bytes(file.size)}，磁碟剩 ${bytes(free)}`);
      return;
    }

    const id = `u${nextId.current++}`;
    const abort = new AbortController();
    const target = folder;
    setTransfers((prev) => [...prev, { id, name: file.name, size: file.size, sent: 0, abort }]);

    uploadComfyFile(root, target, file, (sent) => patch(id, { sent }), abort.signal)
      .then(() => {
        setTransfers((prev) => prev.filter((t) => t.id !== id));
        message.success(`${file.name} 已上傳`);
        void loadFiles(root, target);
        void loadFolders(root);
      })
      .catch((error: Error) => {
        // Kept in the list rather than cleared: the bytes are still on disk as a
        // .part, so dropping the row would hide something that exists and can be
        // resumed by choosing the same file again.
        patch(id, { error: error.name === 'AbortError' ? '已取消' : error.message });
      });
  };

  const onDelete = async (file: ComfyFile) => {
    try {
      const { freed } = await deleteComfyFile(root, folder, file.name, file.partial);
      message.success(`已刪除，釋出 ${bytes(freed)}`);
      void loadFiles(root, folder);
      void loadFolders(root);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const current = folders.find((f) => f.name === folder);
  const canWrite = (activeRoot?.writable ?? false) && (current?.writable ?? false);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
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
                -type d -exec chown 1000:1000 {'{}'} +
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
            onChange={(v) => setRoot(v as string)}
            options={roots.map((r) => ({ label: r.label, value: r.key }))}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>{activeRoot?.note}</Text>
          <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.5, marginLeft: 'auto' }}>
            磁碟可用 {bytes(free)}
          </Text>
        </Space>
      </Card>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Folders are a fixed list, not a tree: ComfyUI's layout is one level
            deep by convention, and the only question being asked is which of
            these names the file belongs under. */}
        <Card
          size="small"
          title={<span style={{ fontSize: 12, opacity: 0.75 }}>資料夾</span>}
          style={{ flex: '0 0 260px', maxHeight: 560, overflowY: 'auto' }}
          styles={{ body: { padding: 4 } }}
        >
          {folders.map((f) => (
            <div
              key={f.name}
              onClick={() => setFolder(f.name)}
              style={{
                padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                display: 'flex', alignItems: 'baseline', gap: 8,
                background: f.name === folder ? 'rgba(255,255,255,0.07)' : undefined,
              }}
            >
              <FolderOutlined style={{ fontSize: 11, opacity: 0.45 }} />
              <Text style={{ fontSize: 12, fontFamily: MONO }}>{f.name}</Text>
              <Text
                type="secondary"
                style={{ fontSize: 10, marginLeft: 'auto', fontFamily: MONO }}
              >
                {f.files || ''}{f.size ? ` ・ ${bytes(f.size)}` : ''}
              </Text>
            </div>
          ))}
          {!folders.length && (
            <Empty description="沒有資料夾" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>

        <Card
          size="small"
          style={{ flex: '1 1 420px', minWidth: 0 }}
          title={
            <span style={{ fontSize: 12, opacity: 0.75, fontFamily: MONO }}>
              {folder || '選一個資料夾'}
            </span>
          }
        >
          {folder ? (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Upload.Dragger
                multiple
                showUploadList={false}
                disabled={!canWrite}
                // The transfer is driven by uploadComfyFile, not by antd: it has
                // to be chunked and resumable, which the built-in one is not.
                beforeUpload={(file) => { startUpload(file as unknown as File); return false; }}
                style={{ padding: '10px 0', background: 'transparent', borderColor: LINE.soft }}
              >
                <p style={{ margin: 0 }}>
                  <InboxOutlined style={{ fontSize: 20, opacity: 0.5 }} />
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.65 }}>
                  拖進來，或點一下選檔案 · 分塊上傳，斷線可續傳
                </p>
              </Upload.Dragger>

              {transfers.map((t) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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

              <Table<ComfyFile>
                size="small"
                loading={loading}
                dataSource={files}
                rowKey={(f) => f.name + (f.partial ? '.part' : '')}
                pagination={false}
                scroll={{ y: 320 }}
                locale={{ emptyText: <Empty description="空的" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                columns={[
                  {
                    title: '檔名',
                    dataIndex: 'name',
                    render: (name: string, file) => (
                      <Space size={6}>
                        <Text style={{ fontSize: 12, fontFamily: MONO }}>{name}</Text>
                        {file.partial && <Tag color="gold" style={{ fontSize: 10 }}>未完成</Tag>}
                      </Space>
                    ),
                  },
                  {
                    title: '大小',
                    dataIndex: 'size',
                    width: 110,
                    align: 'right',
                    render: (n: number) => (
                      <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.7 }}>{bytes(n)}</Text>
                    ),
                  },
                  {
                    title: '',
                    width: 44,
                    align: 'right',
                    render: (_, file) => (
                      <Popconfirm
                        title={`刪除 ${file.name}？`}
                        okText="刪除" cancelText="取消" okButtonProps={{ danger: true }}
                        onConfirm={() => void onDelete(file)}
                      >
                        <Button size="small" type="text" danger icon={<DeleteOutlined />}
                                disabled={!canWrite} />
                      </Popconfirm>
                    ),
                  },
                ]}
              />
            </Space>
          ) : (
            <Empty description="從左邊選一個資料夾" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Card>
      </div>
    </Space>
  );
}
