import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  App as AntApp, Alert, Button, Card, Dropdown, Empty, Input, Modal, Progress, Segmented,
  Space, Splitter, Table, Tag, Tooltip, Typography,
} from 'antd';
import type { InputRef } from 'antd';
import {
  AppstoreOutlined, DeleteOutlined, DownOutlined, DownloadOutlined, DragOutlined,
  EditOutlined, FileOutlined, FolderAddOutlined, FolderOutlined, FormOutlined, MoreOutlined,
  PartitionOutlined, PlusOutlined, QuestionCircleOutlined, QuestionOutlined, StopOutlined,
  UnorderedListOutlined, UploadOutlined,
} from '@ant-design/icons';
import {
  createFsFolder, deleteFsEntry, fetchFsListing, fetchFsRoots, fetchFsSize,
  fsRawUrl, fsThumbUrl, locateFsPath, moveFsEntry, renameFsEntry, uploadFsFile,
  type FsEntry, type FsRoot,
} from '../api';
import FilePreview from '../components/FilePreview';
import FolderPicker from '../components/FolderPicker';
import PathBar from '../components/PathBar';
import DirTree from '../components/DirTree';
import FileEditor from '../components/FileEditor';
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

/** Written out once, so the dialog cannot describe a binding that is not bound. */
const SHORTCUTS: [string, string][] = [
  ['Ctrl / ⌘ + L', '編輯路徑，直接貼絕對路徑跳過去'],
  ['/', '搜尋這個資料夾'],
  ['Backspace', '回上一層'],
  ['Ctrl / ⌘ + A', '全選'],
  ['Esc', '取消選取'],
  ['Ctrl / ⌘ + U', '上傳檔案'],
  ['N', '新增資料夾'],
  ['F2', '重新命名（選一項時）'],
  ['Delete', '刪除已選取的'],
  ['G', '清單／格狀切換'],
  ['← →', '預覽開著時，走前後一個檔案'],
  ['?', '這張表'],
];

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
  const { message, modal } = AntApp.useApp();
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [root, setRoot] = useState('models');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [writable, setWritable] = useState(false);
  const [free, setFree] = useState(0);
  // What is typed, and what has been asked for. Separated so that typing stays
  // responsive while the request trails it by a beat.
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'grid'>('list');
  // Three panes need more room than two. The tree is the one that folds first:
  // it is the pane you can most easily do without, since the path bar still
  // goes up and the listing still goes down.
  const [roomy, setRoomy] = useState(() => window.innerWidth >= 1500);
  const [treeOpen, setTreeOpen] = useState(true);
  // Bumped when a directory appears or disappears, so the tree re-reads instead
  // of showing a branch that no longer matches the disk.
  const [treeToken, setTreeToken] = useState(0);
  // The file open in the editor window, by name. Separate from `previewing`,
  // which is an index that shifts when the listing reloads -- an edit must not
  // follow the selection.
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [renaming, setRenaming] = useState<{ entry: FsEntry; to: string } | null>(null);
  // The names a move applies to. One entry from a row menu, several from the
  // selection -- the dialog and the loop do not need to know which.
  const [moving, setMoving] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  // Set by a jump that named a file, consumed once the listing it belongs to
  // has arrived -- the entry cannot be selected before it exists.
  const pendingOpen = useRef<string | null>(null);
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
  const search = useRef<InputRef>(null);

  const activeRoot = roots.find((r) => r.key === root);
  const at = (name: string) => `${root}:${path}/${name}`;

  const load = useCallback(async (key: string, where: string, needle: string) => {
    setLoading(true);
    try {
      // Hidden files always. A dotfile is a file, and a switch that decides
      // whether the listing is the truth is a switch somebody leaves in the
      // wrong position and then wonders where their file went.
      const data = await fetchFsListing(key, where, true, needle);
      setEntries(data.entries);
      setWritable(data.writable);
      setFree(data.free);
      setTotal(data.total);
      setTruncated(data.truncated);
    } catch (error) {
      message.error((error as Error).message);
      setEntries([]);
      setWritable(false);
      setTotal(0);
      setTruncated(false);
    } finally {
      setLoading(false);
    }
  }, [message]);

  // After anything that adds, removes or renames a directory. The tree caches
  // what it has read, so a listing refresh alone would leave it describing a
  // shape the disk no longer has -- and navigation must not trigger this, or
  // the tree would collapse and re-read on every step.
  const reload = useCallback(() => {
    void load(root, path, query);
    setTreeToken((n) => n + 1);
  }, [load, root, path, query]);

  useEffect(() => {
    fetchFsRoots().then((d) => setRoots(d.roots)).catch(() => undefined);
  }, []);
  // A directory changed under a search is a different question, so the box
  // empties on navigation rather than silently hiding most of where you landed.
  useEffect(() => { setTyped(''); setQuery(''); }, [root, path]);

  // Trailing the keystrokes: without this, typing a nine-character name in a
  // 20000-entry directory is nine listings, of which eight are discarded.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), 250);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    // The open panel is holding an index into a listing that is about to be
    // replaced, and the selection names entries that are about to be gone.
    // Clearing both is the only honest option.
    setPreviewing(null);
    setSelected([]);
    void load(root, path, query);
  }, [root, path, query, load]);

  // Offered where there are pictures, but never taken away once chosen: a
  // deliberate switch to the grid should survive stepping into a subfolder.
  const visual = looksVisual(entries);
  useEffect(() => {
    const onResize = () => {
      setRoomy(window.innerWidth >= 1500);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The preview has two homes and must be in exactly one: a pane beside the
  // listing when there is width, a drawer over it when there is not.
  const treePane = roomy && treeOpen;

  const gridding = view === 'grid' && visual;

  const up = () => {
    if (!path) return;
    const parts = path.split('/');
    parts.pop();
    setPath(parts.join('/'));
  };

  /**
   * Go wherever an absolute path points.
   *
   * The backend does the resolving, so this accepts what somebody pasted out of
   * a terminal -- `~`, `..`, a symlink -- and crosses roots without the page
   * needing to know which one owns it. A path naming a file lands on its folder
   * with the file opened, because that is what someone pasting a checkpoint's
   * full path is after.
   */
  const jump = async (text: string) => {
    try {
      const where = await locateFsPath(text);
      setEditingPath(false);
      if (where.root === root && where.path === path) {
        // Already here, so no listing is coming and nothing would consume a
        // pending open. Find it now or say it is gone.
        const index = entries.findIndex((e) => e.name === where.name && e.kind === 'file');
        if (index >= 0) setPreviewing(index);
        return;
      }
      pendingOpen.current = where.name || null;
      if (where.root !== root) setRoot(where.root);
      setPath(where.path);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  // The listing a jump asked for has arrived; now the file it named can be
  // found in it.
  useEffect(() => {
    const wanted = pendingOpen.current;
    if (!wanted || loading) return;
    pendingOpen.current = null;
    const index = entries.findIndex((e) => e.name === wanted && e.kind === 'file');
    if (index >= 0) setPreviewing(index);
  }, [entries, loading]);

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
        if (which === root && where === path) void load(root, path, query);
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
      reload();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const chosen = entries.filter((e) => selected.includes(`${e.kind}:${e.name}`));

  /**
   * Apply something to several entries, one request each.
   *
   * Sequential rather than concurrent, and it does not stop at the first
   * failure. Half a move that reports "failed" while having moved nine of ten
   * files is worse than one that says which one did not go: the directory is
   * in a state either way, and only the itemised answer describes it.
   */
  const each = async (
    items: FsEntry[],
    verb: string,
    run: (entry: FsEntry) => Promise<unknown>,
  ) => {
    setBusy(true);
    const failed: string[] = [];
    for (const entry of items) {
      try {
        await run(entry);
      } catch (error) {
        failed.push(`${entry.name}：${(error as Error).message}`);
      }
    }
    setBusy(false);
    setSelected([]);
    const done = items.length - failed.length;
    if (done) message.success(`${done} 項已${verb}`);
    if (failed.length) {
      message.error(
        { content: `${failed.length} 項失敗 — ${failed[0]}`, duration: 6 },
      );
    }
    reload();
  };

  const onRename = async () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    if (!to || to === renaming.entry.name) { setRenaming(null); return; }
    try {
      await renameFsEntry(root, path, renaming.entry.name, to);
      setRenaming(null);
      reload();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const onMove = async (toRoot: string, toPath: string) => {
    const names = moving ?? [];
    setMoving(null);
    await each(
      entries.filter((e) => names.includes(e.name)),
      '移動',
      (entry) => moveFsEntry(root, path, entry.name, toRoot, toPath),
    );
  };

  const confirmDelete = (items: FsEntry[]) => modal.confirm({
    title: items.length === 1 ? `刪除 ${items[0].name}？` : `刪除這 ${items.length} 項？`,
    content: items.some((e) => e.kind === 'dir') ? '資料夾必須是空的' : undefined,
    okText: '刪除', cancelText: '取消', okButtonProps: { danger: true },
    onOk: () => each(items, '刪除', (e) => deleteFsEntry(root, path, e.name, e.partial)),
  });

  /**
   * Keys.
   *
   * The bindings are the ones a file manager has had since Explorer: F2
   * renames, Delete deletes, Backspace goes up, Ctrl-L addresses. Nothing is
   * invented, because a shortcut you have to learn is a shortcut nobody uses.
   *
   * Two guards matter. Anything typed into a field is typing, not a command --
   * without that check, naming a folder "n" would open a second dialog on the
   * keystroke. And the preview panel owns the arrows while it is open, so the
   * page stands down entirely rather than the two fighting over a keydown.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      )) {
        return;
      }
      const mod = event.ctrlKey || event.metaKey;

      // Ctrl-L works with a dialog open -- it is how you leave one -- and the
      // rest do not.
      if (mod && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        setPreviewing(null);
        setEditingPath(true);
        return;
      }
      if (previewing !== null || renaming || moving || newFolder !== null || showKeys) return;

      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(entries.filter((e) => e.kind !== 'other').map((e) => `${e.kind}:${e.name}`));
        return;
      }
      if (mod && event.key.toLowerCase() === 'u') {
        event.preventDefault();
        if (writable) picker.current?.click();
        return;
      }
      if (mod) return;

      switch (event.key) {
        case '/':
          event.preventDefault();
          search.current?.focus();
          break;
        case 'Backspace':
          event.preventDefault();
          up();
          break;
        case 'Escape':
          setSelected([]);
          break;
        case 'F2': {
          const one = chosen.length === 1 ? chosen[0] : null;
          if (one && writable && !one.partial) setRenaming({ entry: one, to: one.name });
          break;
        }
        case 'Delete':
          if (chosen.length && writable) confirmDelete(chosen);
          break;
        case 'n':
        case 'N':
          if (writable) setNewFolder('');
          break;
        case 'g':
        case 'G':
          if (visual) setView((v) => (v === 'grid' ? 'list' : 'grid'));
          break;
        case '?':
          setShowKeys(true);
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // No dependency array on purpose. The handler closes over most of this
    // component's state, and listing them would be a list that goes stale
    // silently -- a forgotten entry means a key acting on the directory you
    // were in two navigations ago. Re-binding one listener per render costs
    // nothing measurable.
  });

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

      {/* One block, not two. The places, the path and the listing are the
          same object seen at three scales -- picking a place changes the path,
          which changes the listing -- and a border between the first and the
          other two said they were separate things. */}
      <Card
        size="small"
        // The header holds a block now, and antd's title is a single ellipsised
        // line by default -- left alone it would clip the second strip and the
        // note off the end of the first one.
        styles={{
          title: { whiteSpace: 'normal', overflow: 'visible' },
          header: { padding: '10px 12px' },
        }}
        title={
          <div>
          <Space size={16} wrap align="start" style={{ width: '100%' }}>
            {/* Two strips, not one row of six. ComfyUI's trees are why this page
                exists and there are several of them; the machine's own
                directories are a different kind of place, and in one row they all
                read as an undifferentiated list -- three of them starting with the
                same word. Only the strip holding the selection shows one:
                Segmented renders nothing as chosen when its value is not among
                its options. */}
            <Space direction="vertical" size={6}>
              {([['comfy', 'ComfyUI'], ['other', '其他']] as const).map(([g, label]) => {
                const mine = roots.filter((r) => r.group === g);
                if (!mine.length) return null;
                return (
                  <Space key={g} size={8}>
                    <Text type="secondary" style={{
                      fontSize: 11, width: 48, display: 'inline-block',
                    }}>
                      {label}
                    </Text>
                    <Segmented
                      size="small"
                      value={mine.some((r) => r.key === root) ? root : ''}
                      onChange={(v) => { setRoot(v as string); setPath(''); }}
                      options={mine.map((r) => ({ label: r.label, value: r.key }))}
                    />
                  </Space>
                );
              })}
            </Space>
            <Text style={{
              fontSize: 11, fontFamily: MONO, opacity: 0.5, marginLeft: 'auto',
            }}>
              磁碟可用 {bytes(free)}
            </Text>
          </Space>

          {/* The chosen place's own line, under the strips rather than beside
              them. In the same row it was vertically centred against a two-row
              block and read as a caption for neither of them. */}
          {activeRoot?.note && (
            <Text type="secondary" style={{
              fontSize: 11, display: 'block', marginTop: 10,
            }}>
              {activeRoot.note}
            </Text>
          )}
          </div>
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
            <Input.Search
              ref={search}
              size="small"
              allowClear
              placeholder="搜尋這個資料夾（/）"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{ width: 190 }}
            />
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
            {roomy && (
              <Tooltip title={treeOpen ? '隱藏目錄樹' : '顯示目錄樹'}>
                <Button
                  size="small"
                  type={treeOpen ? 'default' : 'text'}
                  icon={<PartitionOutlined />}
                  onClick={() => setTreeOpen((v) => !v)}
                />
              </Tooltip>
            )}
            <Button size="small" onClick={() => void load(root, path, query)}>重新整理</Button>
            <Tooltip title="快捷鍵（?）">
              <Button
                size="small" type="text" icon={<QuestionCircleOutlined />}
                onClick={() => setShowKeys(true)}
              />
            </Tooltip>
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

          {truncated && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 10 }}
              message={
                <span style={{ fontSize: 12 }}>
                  這裡有 {total.toLocaleString()} 個項目，只顯示前 {entries.length.toLocaleString()} 個。
                  用上面的搜尋找特定的檔案 — 搜尋是在伺服器端跑的，找得到沒顯示出來的那些。
                </span>
              }
            />
          )}

          {chosen.length > 0 && (
            <Space
              size={8}
              style={{
                width: '100%', marginBottom: 10, padding: '6px 10px',
                background: 'rgba(255,255,255,0.04)', borderRadius: 4,
              }}
            >
              <Text style={{ fontSize: 12 }}>已選 {chosen.length} 項</Text>
              <Button
                size="small" icon={<DragOutlined />} disabled={!writable || busy}
                onClick={() => setMoving(chosen.map((e) => e.name))}
              >
                移動
              </Button>
              <Button
                size="small" danger icon={<DeleteOutlined />} disabled={!writable || busy}
                onClick={() => confirmDelete(chosen)}
              >
                刪除
              </Button>
              <Button size="small" type="text" onClick={() => setSelected([])}>取消選取</Button>
            </Space>
          )}

          {/* Listing beside the preview rather than under a drawer that covers
              it. Looking at a file is nearly always a question about which file,
              and a panel that hides the directory answers it with the directory
              out of sight -- the arrows step through a list you can no longer
              see. Split only when there is room; below that width the drawer is
              still the better of two bad options. */}
          <Splitter style={{ minHeight: 240 }}>
            {treePane && (
              <Splitter.Panel defaultSize={220} min={160} max={380} collapsible>
                <DirTree
                  root={root}
                  path={path}
                  refreshToken={treeToken}
                  onNavigate={(next) => { setPath(next); setSelected([]); }}
                />
              </Splitter.Panel>
            )}
            <Splitter.Panel min={280}>
              <div>
              {/* Above the table rather than in the card's header, so it lines
                  up with 名稱 and stays lined up: the tree beside it is a
                  resizable panel, and a header padded to today's width would
                  come apart the first time somebody dragged it. The path
                  describes what is in this column anyway. */}
              <div style={{ padding: '2px 8px 10px' }}>
                <PathBar
                  rootPath={activeRoot?.path ?? ''}
                  path={path}
                  onSegment={setPath}
                  onSubmit={(text) => void jump(text)}
                  editing={editingPath}
                  onEditing={setEditingPath}
                />
              </div>
              {gridding ? (
                <Grid entries={entries} root={root} path={path} onOpen={open} />
              ) : (
              <Table<FsEntry>
                size="small"
                loading={loading}
                dataSource={entries}
                rowKey={(row) => `${row.kind}:${row.name}`}
                rowSelection={{
                  selectedRowKeys: selected,
                  onChange: (keys) => setSelected(keys as string[]),
                  // Devices and sockets have no operation that would apply to them.
                  getCheckboxProps: (row) => ({ disabled: row.kind === 'other' }),
                  columnWidth: 36,
                }}
                pagination={false}
                // Rows are drawn only where they are looked at. Three thousand
                // ordinary antd rows is a second of layout and a scrollbar that
                // stutters; virtual needs every column to carry a width and an x
                // for the total, which is the whole cost of it.
                virtual={entries.length > 200}
                // 36 selection + 400 name + 150 size + 130 modified + 78 actions.
                scroll={{ y: 460, x: 794 }}
                locale={{
                  emptyText: (
                    <Empty
                      description={
                        query
                          ? `沒有符合「${query}」的項目`
                          : writable ? '空的 — 拖檔案進來，或用右上角的「新建」' : '空的'
                      }
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                  ),
                }}
                columns={[
                  {
                    title: '名稱',
                    // A width is required for the virtual renderer; the sum of the
                    // widths is the `x` above, so nothing overflows or leaves a gap.
                    width: 400,
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
                        <Dropdown
                          trigger={['click']}
                          disabled={row.kind === 'other'}
                          menu={{
                            items: [
                              // Only for text, and only where the directory
                              // takes writes: an edit item opening a window
                              // whose save button can never work is worse than
                              // no item at all.
                              ...(row.kind === 'file' && row.media === 'text' && !row.partial
                                ? [{
                                  key: 'edit',
                                  label: writable ? '編輯' : '檢視原始碼',
                                  icon: <FormOutlined />,
                                  onClick: () => setEditing(row.name),
                                }]
                                : []),
                              {
                                key: 'rename',
                                label: '重新命名',
                                icon: <EditOutlined />,
                                disabled: !writable || row.partial,
                                onClick: () => setRenaming({ entry: row, to: row.name }),
                              },
                              {
                                key: 'move',
                                label: '移動到…',
                                icon: <DragOutlined />,
                                disabled: !writable || row.partial,
                                onClick: () => setMoving([row.name]),
                              },
                              { type: 'divider' },
                              {
                                key: 'delete',
                                label: '刪除',
                                icon: <DeleteOutlined />,
                                danger: true,
                                disabled: !writable,
                                onClick: () => confirmDelete([row]),
                              },
                            ],
                          }}
                        >
                          <Button size="small" type="text" icon={<MoreOutlined />} />
                        </Dropdown>
                      </Space>
                    ),
                  },
                ]}
              />
              )}
              </div>
            </Splitter.Panel>
          </Splitter>
        </div>
      </Card>

      {editing && (
        <FileEditor
          root={root}
          path={path}
          name={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void load(root, path, query)}
        />
      )}

      {previewing !== null && (
        <FilePreview
          root={root}
          path={path}
          entries={entries}
          index={previewing}
          onIndex={setPreviewing}
          onClose={() => setPreviewing(null)}
          onEdit={(name) => { setPreviewing(null); setEditing(name); }}
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

      <Modal
        open={renaming !== null}
        title="重新命名"
        okText="更名" cancelText="取消"
        onOk={() => void onRename()}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={renaming?.to ?? ''}
          onChange={(e) => setRenaming((prev) => (prev ? { ...prev, to: e.target.value } : prev))}
          onPressEnter={() => void onRename()}
        />
        <Text type="secondary" style={{ fontSize: 11 }}>
          只是換個名字，位置不變。同名的東西已經存在時會拒絕。
        </Text>
      </Modal>

      <Modal
        open={showKeys}
        title="快捷鍵"
        footer={null}
        onCancel={() => setShowKeys(false)}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px' }}>
          {SHORTCUTS.map(([keys, what]) => (
            <Fragment key={keys}>
              <kbd
                style={{
                  fontFamily: MONO, fontSize: 11, padding: '2px 7px',
                  border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4,
                  background: 'rgba(255,255,255,0.05)', whiteSpace: 'nowrap',
                }}
              >
                {keys}
              </kbd>
              <Text style={{ fontSize: 12 }}>{what}</Text>
            </Fragment>
          ))}
        </div>
      </Modal>

      {moving && (
        <FolderPicker
          roots={roots}
          fromRoot={root}
          fromPath={path}
          moving={moving}
          title={moving.length === 1 ? `移動 ${moving[0]}` : `移動 ${moving.length} 項`}
          onPick={(toRoot, toPath) => void onMove(toRoot, toPath)}
          onCancel={() => setMoving(null)}
        />
      )}
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
