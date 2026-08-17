import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Breadcrumb, Button, Card, Dropdown, Empty, Input, Modal,
  Popconfirm, Progress, Segmented, Space, Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  AppstoreOutlined, DeleteOutlined, DownloadOutlined, DownOutlined,
  FileOutlined, FolderAddOutlined, FolderOutlined, PlusOutlined,
  QuestionOutlined, StopOutlined, UnorderedListOutlined, UploadOutlined,
} from '@ant-design/icons';
import {
  createFsFolder, deleteFsEntry, fetchFsListing, fetchFsRoots, fetchFsSize,
  fsRawUrl, fsThumbUrl, uploadFsFile,
  type FsEntry, type FsRoot,
} from '../api';
import FilePreview from '../components/FilePreview';
import { MONO } from '../theme';

const { Text } = Typography;

/**
 * The machine's directories.
 *
 * This began as ComfyUI's model folders, which have no API: ComfyUI can list
 * what it found but has no way to be given anything, so getting a 20 GB
 * checkpoint onto this machine meant a shell. It now reaches whatever the
 * backend exposes, which by default is those folders plus the home directory.
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
  if (!seconds) return '';
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

/** A directory's recursive size, once somebody has asked for it. */
type Measured = { files: number; bytes: number } | 'working';

/**
 * Whether the grid is worth offering here.
 *
 * A grid of filenames is a worse list, so it only earns its place where there
 * are pictures. Two of them is enough to mean "this is an output folder" and
 * few enough that one stray screenshot in a directory of scripts does not
 * change the view on somebody.
 */
function looksVisual(entries: FsEntry[]): boolean {
  let seen = 0;
  for (const entry of entries) {
    if (entry.media === 'image' || entry.media === 'video') seen += 1;
    if (seen >= 2) return true;
  }
  return false;
}

export default function Files() {
  const { message } = AntApp.useApp();
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [root, setRoot] = useState('models');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [writable, setWritable] = useState(false);
  const [free, setFree] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'grid'>('list');
  // An index into `entries` rather than the entry itself, so the arrows inside
  // the panel can walk the directory without the page handing it a new object.
  const [previewing, setPreviewing] = useState<number | null>(null);
  // Keyed by the full location so that navigating away and back does not throw
  // away a measurement that cost a walk of the tree.
  const [sizes, setSizes] = useState<Record<string, Measured>>({});
  // Uploads outlive a navigation step, so the queue is keyed by its own id
  // rather than by whatever is on screen.
  const nextId = useRef(0);
  const picker = useRef<HTMLInputElement>(null);

  const activeRoot = roots.find((r) => r.key === root);
  const segments = path ? path.split('/') : [];
  const at = (name: string) => `${root}:${path}/${name}`;

  const load = useCallback(async (key: string, where: string, showHidden: boolean) => {
    setLoading(true);
    try {
      const data = await fetchFsListing(key, where, showHidden);
      setEntries(data.entries);
      setWritable(data.writable);
      setFree(data.free);
    } catch (error) {
      message.error((error as Error).message);
      setEntries([]);
      setWritable(false);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    fetchFsRoots().then((d) => setRoots(d.roots)).catch(() => undefined);
  }, []);
  useEffect(() => {
    // The open panel is holding an index into a listing that is about to be
    // replaced. Closing it is the only honest option.
    setPreviewing(null);
    void load(root, path, hidden);
  }, [root, path, hidden, load]);

  // Offered where there are pictures, but never taken away once chosen: a
  // deliberate switch to the grid should survive stepping into a subfolder.
  const visual = looksVisual(entries);
  const gridding = view === 'grid' && visual;

  const open = (entry: FsEntry) => {
    if (entry.kind === 'dir') {
      setPath(path ? `${path}/${entry.name}` : entry.name);
      return;
    }
    if (entry.kind === 'file') setPreviewing(entries.indexOf(entry));
  };

  const measure = async (name: string) => {
    const key = at(name);
    setSizes((prev) => ({ ...prev, [key]: 'working' }));
    try {
      const measured = await fetchFsSize(root, path, name);
      setSizes((prev) => ({ ...prev, [key]: measured }));
    } catch (error) {
      setSizes((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      message.error((error as Error).message);
    }
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
    const where = path;
    const which = root;
    setTransfers((prev) => [...prev, { id, name: file.name, size: file.size, sent: 0, abort }]);

    uploadFsFile(which, where, file, (sent) => patch(id, { sent }), abort.signal)
      .then(() => {
        setTransfers((prev) => prev.filter((t) => t.id !== id));
        message.success(`${file.name} 已上傳`);
        if (which === root && where === path) void load(root, path, hidden);
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
      await createFsFolder(root, path, name);
      setNewFolder(null);
      void load(root, path, hidden);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const onDelete = async (entry: FsEntry) => {
    try {
      const { freed } = await deleteFsEntry(root, path, entry.name, entry.partial);
      message.success(freed ? `已刪除，釋出 ${bytes(freed)}` : '已刪除');
      void load(root, path, hidden);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <input ref={picker} type="file" multiple hidden onChange={onPick} />

      {activeRoot && activeRoot.exists && !activeRoot.writable && (
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
            onChange={(v) => { setRoot(v as string); setPath(''); }}
            options={roots.map((r) => ({ label: r.label, value: r.key }))}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>{activeRoot?.note}</Text>
          <Space size={6} style={{ marginLeft: 'auto' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>隱藏檔</Text>
            <Switch size="small" checked={hidden} onChange={setHidden} />
            <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.5, marginLeft: 10 }}>
              磁碟可用 {bytes(free)}
            </Text>
          </Space>
        </Space>
      </Card>

      <Card
        size="small"
        title={
          <Breadcrumb
            style={{ fontSize: 12, fontFamily: MONO }}
            items={[
              { title: <a onClick={() => setPath('')}>{activeRoot?.label ?? root}</a> },
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
            {visual && (
              <Segmented
                size="small"
                value={view}
                onChange={(v) => setView(v as 'list' | 'grid')}
                options={[
                  { value: 'list', icon: <UnorderedListOutlined /> },
                  { value: 'grid', icon: <AppstoreOutlined /> },
                ]}
              />
            )}
            <Button size="small" onClick={() => void load(root, path, hidden)}>重新整理</Button>
          </Space>
        }
      >
        {/* The drop target is the whole panel rather than a separate box: with
            the listing already filling it, a dedicated dragger would be a third
            region competing for the same space. */}
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

          {gridding ? (
            <Grid entries={entries} root={root} path={path} onOpen={open} />
          ) : (
          <Table<FsEntry>
            size="small"
            loading={loading}
            dataSource={entries}
            rowKey={(row) => `${row.kind}:${row.name}`}
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
                render: (_, row) => (
                  <Space size={7}>
                    {row.kind === 'dir'
                      ? <FolderOutlined style={{ fontSize: 11, opacity: 0.5 }} />
                      : row.kind === 'other'
                        ? <QuestionOutlined style={{ fontSize: 11, opacity: 0.35 }} />
                        : <span style={{ display: 'inline-block', width: 11 }} />}
                    {row.kind === 'other' ? (
                      <Text
                        style={{ fontSize: 12, fontFamily: MONO, opacity: 0.55 }}
                      >
                        {row.name}
                      </Text>
                    ) : (
                      <a
                        style={{
                          fontSize: 12, fontFamily: MONO,
                          opacity: row.hidden ? 0.6 : 1,
                        }}
                        onClick={() => open(row)}
                      >
                        {row.name}
                      </a>
                    )}
                    {row.partial && <Tag color="gold" style={{ fontSize: 10 }}>未完成</Tag>}
                    {row.kind === 'other' && (
                      <Tooltip title="裝置、通訊端或斷掉的連結。列出來是為了跟 ls 一致，但打不開。">
                        <Tag style={{ fontSize: 10 }}>特殊</Tag>
                      </Tooltip>
                    )}
                  </Space>
                ),
              },
              {
                title: '大小',
                width: 150,
                align: 'right',
                render: (_, row) => {
                  if (row.kind !== 'dir') {
                    return (
                      <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.65 }}>
                        {bytes(row.size ?? 0)}
                      </Text>
                    );
                  }
                  // Asked for, not volunteered. Computing this for every folder
                  // while listing is what made the old version walk the entire
                  // disk on each navigation step.
                  const measured = sizes[at(row.name)];
                  if (measured === 'working') {
                    return <Text type="secondary" style={{ fontSize: 11 }}>計算中…</Text>;
                  }
                  if (measured) {
                    return (
                      <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.65 }}>
                        {measured.files} 項 ・ {bytes(measured.bytes)}
                      </Text>
                    );
                  }
                  return (
                    <Button
                      size="small" type="text"
                      style={{ fontSize: 11, opacity: 0.5 }}
                      onClick={() => void measure(row.name)}
                    >
                      計算大小
                    </Button>
                  );
                },
              },
              {
                title: '修改時間',
                width: 130,
                align: 'right',
                render: (_, row) => (
                  <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.45 }}>
                    {when(row.modified)}
                  </Text>
                ),
              },
              {
                title: '',
                width: 78,
                align: 'right',
                render: (_, row) => (
                  <Space size={0}>
                    {row.kind === 'file' && !row.partial && (
                      <Tooltip title="下載">
                        {/* An anchor rather than a fetch: the browser's own
                            download manager handles a 20 GB file, and nothing
                            has to hold it in memory to offer it. */}
                        <Button
                          size="small" type="text" icon={<DownloadOutlined />}
                          href={fsRawUrl(root, path, row.name, true)}
                        />
                      </Tooltip>
                    )}
                    <Popconfirm
                      title={`刪除 ${row.name}？`}
                      description={row.kind === 'dir' ? '資料夾必須是空的' : undefined}
                      okText="刪除" cancelText="取消" okButtonProps={{ danger: true }}
                      onConfirm={() => void onDelete(row)}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />}
                              disabled={!writable} />
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
          )}
        </div>
      </Card>

      {previewing !== null && (
        <FilePreview
          root={root}
          path={path}
          entries={entries}
          index={previewing}
          onIndex={setPreviewing}
          onClose={() => setPreviewing(null)}
        />
      )}

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

/**
 * The same listing as pictures.
 *
 * Auto-fill rather than a fixed column count: this panel is the width of the
 * window minus a sidebar that collapses, and a grid that reflows is the whole
 * reason to use one.
 */
function Grid({ entries, root, path, onOpen }: {
  entries: FsEntry[];
  root: string;
  path: string;
  onOpen: (entry: FsEntry) => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
        gap: 12,
        maxHeight: 520,
        overflowY: 'auto',
      }}
    >
      {entries.map((entry) => (
        <div
          key={`${entry.kind}:${entry.name}`}
          onClick={() => onOpen(entry)}
          style={{
            cursor: entry.kind === 'other' ? 'default' : 'pointer',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6,
            overflow: 'hidden',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div
            style={{
              height: 116, display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: 'rgba(0,0,0,0.25)',
            }}
          >
            {entry.media === 'image' && !entry.partial ? (
              // Lazy so that a folder of four hundred renders costs four
              // hundred requests only if somebody scrolls that far.
              <img
                src={fsThumbUrl(root, path, entry.name)}
                alt={entry.name}
                loading="lazy"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              />
            ) : entry.kind === 'dir' ? (
              <FolderOutlined style={{ fontSize: 30, opacity: 0.3 }} />
            ) : (
              <FileOutlined style={{ fontSize: 26, opacity: 0.25 }} />
            )}
          </div>
          <div style={{ padding: '6px 8px' }}>
            <Text
              ellipsis={{ tooltip: entry.name }}
              style={{ fontSize: 11, fontFamily: MONO, display: 'block' }}
            >
              {entry.name}
            </Text>
            <Text type="secondary" style={{ fontSize: 10, fontFamily: MONO }}>
              {entry.kind === 'dir' ? '資料夾' : bytes(entry.size ?? 0)}
            </Text>
          </div>
        </div>
      ))}
    </div>
  );
}
