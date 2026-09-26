import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp, Button, Drawer, Dropdown, Empty, Input, Modal, Progress, Segmented, Select,
  Space, Spin, Tag, Tooltip, Typography,
} from 'antd';
import type { InputRef, MenuProps } from 'antd';
import {
  AppstoreOutlined, CloseOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined,
  FileImageOutlined, FileOutlined, FileTextOutlined, FolderAddOutlined, FolderOpenOutlined,
  FolderOutlined, FormOutlined, HddOutlined, HomeOutlined, InfoCircleOutlined,
  PlayCircleOutlined, QuestionCircleOutlined, ReloadOutlined, SearchOutlined,
  SoundOutlined, UnorderedListOutlined, UploadOutlined, DatabaseOutlined,
} from '@ant-design/icons';
import {
  createFsFolder, deleteFsEntry, fetchFsListing, fetchFsRoots, fetchFsSize, fsRawUrl,
  fsThumbUrl, locateFsPath, moveFsEntry, renameFsEntry, uploadFsFile,
  type FsEntry, type FsRoot,
} from '../api';
import FilePreview from '../components/FilePreview';
import { useMedia } from '../media';
import FolderPicker from '../components/FolderPicker';
import Details from '../components/files/Details';
import Editor from '../components/files/Editor';
import {
  bytes, keyOf, looksVisual, SHORTCUTS, when, type Measured, type Transfer,
} from '../components/files/kit';
import { ACCENT, LINE, MONO } from '../theme';
import '../components/files/files.css';

const { Text } = Typography;

/**
 * The machine's directories, laid out the way a file manager is.
 *
 * Locations down the left, the path across the top as crumbs, the folder in
 * the middle, and on the right what the selection is. Everything that used
 * to hang off each row -- a checkbox, a size link, a menu -- lives in that
 * right-hand pane or on the selection-aware toolbar, so a row is a name, a
 * size and a time, and picking one is a click.
 *
 * Editing is a tab, not a dialog. The folder view is the first tab and every
 * opened text file adds one beside it, with Monaco underneath; the file can
 * be looked at, left, and come back to, which a modal never allowed.
 *
 * This began as ComfyUI's model folders, which have no API: ComfyUI can list
 * what it found but has no way to be given anything, so getting a 20 GB
 * checkpoint onto this machine meant a shell. It now reaches whatever the
 * backend exposes: those folders plus the home directory by default.
 */

const SIDEBAR_W = 196;
const DETAILS_W = 300;

interface Tab {
  key: string;
  root: string;
  path: string;
  name: string;
  dirty: boolean;
}

function iconFor(entry: FsEntry) {
  if (entry.kind === 'dir') return <FolderOutlined />;
  switch (entry.media) {
    case 'image': return <FileImageOutlined />;
    case 'video': return <PlayCircleOutlined />;
    case 'audio': return <SoundOutlined />;
    case 'text': return <FileTextOutlined />;
    case 'model': return <DatabaseOutlined />;
    default: return <FileOutlined />;
  }
}

export default function Files() {
  const { message, modal } = AntApp.useApp();

  // ---- where -----------------------------------------------------------------
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [root, setRoot] = useState('models');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [writable, setWritable] = useState(false);
  const [free, setFree] = useState(0);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  // What is typed, and what has been asked for. Separated so that typing stays
  // responsive while the request trails it by a beat.
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [pathText, setPathText] = useState('');

  // ---- what is picked ---------------------------------------------------------
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  // Grid where there are pictures, until somebody says otherwise; a choice
  // survives stepping into a subfolder.
  const [view, setView] = useState<'auto' | 'list' | 'grid'>('auto');
  // The panel takes 300 px beside the list, which a window under about 1200
  // cannot spare without the file names going: there it slides in when asked
  // for instead, and starts closed.
  const detailsBeside = useMedia('(min-width: 1200px)');
  const [detailsOpen, setDetailsOpen] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  // Narrower still, the locations list becomes a dropdown on the toolbar, and
  // the list drops its date column so the names keep the room.
  const locationsBeside = useMedia('(min-width: 900px)');
  const compact = useMedia('(max-width: 699px)');
  const [sizes, setSizes] = useState<Record<string, Measured>>({});

  // ---- what is happening -------------------------------------------------------
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [busy, setBusy] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ entry: FsEntry; to: string } | null>(null);
  const [moving, setMoving] = useState<FsEntry[] | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // ---- tabs ---------------------------------------------------------------------
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState('browser');

  const nextId = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const search = useRef<InputRef>(null);
  const pathInput = useRef<InputRef>(null);

  const activeRoot = roots.find((r) => r.key === root);
  const rootPath = activeRoot?.path ?? '';
  const at = (name: string) => `${root}:${path}/${name}`;
  const chosen = useMemo(
    () => entries.filter((e) => selected.includes(keyOf(e))),
    [entries, selected],
  );
  const visual = looksVisual(entries);
  const gridding = visual && view !== 'list';

  // ---- loading ------------------------------------------------------------------
  const load = useCallback(async (key: string, where: string, needle: string) => {
    setLoading(true);
    try {
      // Hidden files always. A dotfile is a file, and a switch that decides
      // whether the listing is the truth is a switch somebody leaves in the
      // wrong position and then wonders where their file went.
      const data = await fetchFsListing(key, where, true, needle);
      setEntries(data.entries ?? []);
      setWritable(data.writable);
      setFree(data.free);
      setTotal(data.total ?? 0);
      setTruncated(data.truncated ?? false);
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

  const reload = useCallback(() => { void load(root, path, query); }, [load, root, path, query]);

  useEffect(() => {
    fetchFsRoots().then((d) => {
      setRoots(d.roots);
      // Another page may send somebody straight to one tree -- the ComfyUI
      // page points at an instance's output, which is where the pictures are.
      const wanted = new URLSearchParams(window.location.search).get('root');
      if (wanted && d.roots.some((r) => r.key === wanted)) {
        setRoot(wanted);
        setPath('');
      }
    }).catch(() => undefined);
  }, []);

  // A directory changed under a search is a different question, so the box
  // empties on navigation rather than silently hiding most of where you landed.
  useEffect(() => { setTyped(''); setQuery(''); }, [root, path]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), 250);
    return () => clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    // The viewer holds an index into a listing that is about to be replaced,
    // and the selection names entries that are about to be gone.
    setViewing(null);
    setSelected([]);
    anchor.current = null;
    void load(root, path, query);
  }, [root, path, query, load]);

  // ---- navigation -----------------------------------------------------------------
  const go = (key: string, where: string) => {
    setRoot(key);
    setPath(where);
    setActive('browser');
  };
  const up = () => {
    if (!path) return;
    const parts = path.split('/');
    parts.pop();
    setPath(parts.join('/'));
  };

  /**
   * Go wherever an absolute path points.
   *
   * The backend does the resolving, so this accepts what somebody pasted out
   * of a terminal -- `~`, `..`, a symlink -- and crosses roots without the
   * page needing to know which one owns it. A path naming a file lands on
   * its folder with the file selected.
   */
  const pendingSelect = useRef<string | null>(null);
  const jump = async (text: string) => {
    try {
      const where = await locateFsPath(text);
      setEditingPath(false);
      pendingSelect.current = where.name || null;
      go(where.root, where.path);
    } catch (error) {
      message.error((error as Error).message);
    }
  };
  useEffect(() => {
    if (!pendingSelect.current || loading) return;
    const hit = entries.find((e) => e.name === pendingSelect.current);
    pendingSelect.current = null;
    if (hit) setSelected([keyOf(hit)]);
  }, [entries, loading]);

  const startEditingPath = () => {
    setPathText(path ? `${rootPath}/${path}` : rootPath);
    setEditingPath(true);
    setTimeout(() => pathInput.current?.focus({ cursor: 'end' }), 0);
  };

  // ---- tabs -----------------------------------------------------------------------
  const openEditor = (entry: FsEntry) => {
    const key = `${root}:${path}/${entry.name}`;
    setTabs((prev) => (prev.some((t) => t.key === key)
      ? prev
      : [...prev, { key, root, path, name: entry.name, dirty: false }]));
    setActive(key);
  };
  const closeTab = (key: string) => {
    const tab = tabs.find((t) => t.key === key);
    const drop = () => {
      setTabs((prev) => prev.filter((t) => t.key !== key));
      if (active === key) setActive('browser');
    };
    if (tab?.dirty) {
      modal.confirm({
        title: `${tab.name} 還沒儲存`,
        content: '關掉會丟掉這次的修改。',
        okText: '不存，關掉', cancelText: '取消', okButtonProps: { danger: true },
        onOk: drop,
      });
    } else {
      drop();
    }
  };
  const markDirty = useCallback((key: string, dirty: boolean) => {
    setTabs((prev) => prev.map((t) => (t.key === key && t.dirty !== dirty ? { ...t, dirty } : t)));
  }, []);

  // ---- opening ----------------------------------------------------------------------
  const open = (entry: FsEntry) => {
    if (entry.kind === 'dir') {
      setPath(path ? `${path}/${entry.name}` : entry.name);
      return;
    }
    if (entry.kind !== 'file' || entry.partial) return;
    if (entry.media === 'text') {
      openEditor(entry);
    } else if (entry.media === 'image' || entry.media === 'video' || entry.media === 'model') {
      setViewing(entries.indexOf(entry));
    } else {
      window.open(fsRawUrl(root, path, entry.name, true), '_blank');
    }
  };

  // ---- selection ----------------------------------------------------------------------
  const pick = (entry: FsEntry, event: React.MouseEvent) => {
    const key = keyOf(entry);
    if (event.shiftKey && anchor.current) {
      const keys = entries.map(keyOf);
      const a = keys.indexOf(anchor.current);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(keys.slice(lo, hi + 1));
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    } else {
      setSelected([key]);
    }
    anchor.current = key;
  };

  // ---- actions --------------------------------------------------------------------------
  const measure = async (name: string) => {
    const key = at(name);
    setSizes((prev) => ({ ...prev, [key]: 'working' }));
    try {
      const measured = await fetchFsSize(root, path, name);
      setSizes((prev) => ({ ...prev, [key]: measured }));
    } catch (error) {
      setSizes((prev) => { const next = { ...prev }; delete next[key]; return next; });
      message.error((error as Error).message);
    }
  };

  const patch = (id: string, change: Partial<Transfer>) =>
    setTransfers((prev) => prev.map((t) => (t.id === id ? { ...t, ...change } : t)));

  const startUpload = (file: File, toRoot = root, toPath = path) => {
    if (file.size > free) {
      // Refused here rather than after twenty minutes of transfer.
      message.error(`空間不足：這個檔案 ${bytes(file.size)}，磁碟剩 ${bytes(free)}`);
      return;
    }
    const id = `u${nextId.current++}`;
    const abort = new AbortController();
    setTransfers((prev) => [...prev, {
      id, name: file.name, root: toRoot, path: toPath, size: file.size, sent: 0, abort,
    }]);
    uploadFsFile(toRoot, toPath, file, (sent) => patch(id, { sent }), abort.signal)
      .then(() => {
        setTransfers((prev) => prev.filter((t) => t.id !== id));
        message.success(`${file.name} 已上傳`);
        if (toRoot === root && toPath === path) reload();
      })
      .catch((error: Error) => {
        // Kept in the list rather than cleared: the bytes are still on disk as
        // a .part, so dropping the row would hide something that exists and
        // can be resumed by choosing the same file again.
        patch(id, { error: error.name === 'AbortError' ? '已取消' : error.message });
      });
  };

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    Array.from(event.target.files ?? []).forEach((f) => startUpload(f));
    // Cleared so choosing the same file twice fires change again, which is
    // how a failed upload is retried.
    event.target.value = '';
  };

  const each = async (items: FsEntry[], verb: string, run: (entry: FsEntry) => Promise<unknown>) => {
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
    if (failed.length) message.error({ content: `${failed.length} 項失敗 — ${failed[0]}`, duration: 6 });
    reload();
  };

  const confirmDelete = (items: FsEntry[]) => {
    modal.confirm({
      title: items.length === 1 ? `刪除 ${items[0].name}？` : `刪除 ${items.length} 項？`,
      content: items.some((e) => e.kind === 'dir') ? '資料夾裡的東西會一起刪掉，而且不能復原。' : '不能復原。',
      okText: '刪除', cancelText: '取消', okButtonProps: { danger: true },
      onOk: () => each(items, '刪除', (e) => deleteFsEntry(root, path, e.name, e.partial)),
    });
  };

  const onCreateFolder = async () => {
    const name = (newFolder ?? '').trim();
    if (!name) return;
    setBusy(true);
    try {
      await createFsFolder(root, path, name);
      setNewFolder(null);
      message.success(`已建立 ${name}`);
      reload();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRename = async () => {
    if (!renaming) return;
    const to = renaming.to.trim();
    if (!to || to === renaming.entry.name) { setRenaming(null); return; }
    setBusy(true);
    try {
      await renameFsEntry(root, path, renaming.entry.name, to);
      setRenaming(null);
      reload();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const moveTo = (items: FsEntry[], toRoot: string, toPath: string) => {
    setMoving(null);
    if (toRoot === root && toPath === path) return;
    void each(items, '移動', (e) => moveFsEntry(root, path, e.name, toRoot, toPath));
  };

  // ---- drag and drop --------------------------------------------------------------------
  // Two kinds of drag land here: files from the desktop, which are uploads,
  // and rows from the listing, which are moves. Telling them apart is the
  // type on the transfer, which only our own rows set.
  const DRAG = 'application/x-tenkstack-entries';
  const dragEntries = (e: React.DragEvent) => {
    try {
      const names = JSON.parse(e.dataTransfer.getData(DRAG) || 'null') as string[] | null;
      return names ? entries.filter((x) => names.includes(x.name)) : null;
    } catch { return null; }
  };
  const startDrag = (entry: FsEntry) => (e: React.DragEvent) => {
    const names = selected.includes(keyOf(entry)) ? chosen.map((x) => x.name) : [entry.name];
    e.dataTransfer.setData(DRAG, JSON.stringify(names));
    e.dataTransfer.effectAllowed = 'move';
  };
  const acceptsDrop = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG);
  const dropInto = (toRoot: string, toPath: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const moved = dragEntries(e);
    if (moved) {
      if (moved.some((x) => x.kind === 'dir' && toRoot === root && toPath === (path ? `${path}/${x.name}` : x.name))) return;
      moveTo(moved, toRoot, toPath);
      return;
    }
    Array.from(e.dataTransfer.files).forEach((f) => startUpload(f, toRoot, toPath));
  };

  // ---- keys --------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        setViewing(null);
        setActive('browser');
        startEditingPath();
        return;
      }
      if (active !== 'browser') return;
      if (viewing !== null || renaming || moving || newFolder !== null || showKeys) return;
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(entries.filter((e) => e.kind !== 'other').map(keyOf));
        return;
      }
      if (mod && event.key.toLowerCase() === 'u') {
        event.preventDefault();
        if (writable) picker.current?.click();
        return;
      }
      if (mod) return;
      switch (event.key) {
        case '/': event.preventDefault(); search.current?.focus(); break;
        case 'Backspace': event.preventDefault(); up(); break;
        case 'Escape': setSelected([]); break;
        case 'Enter': if (chosen.length === 1) open(chosen[0]); break;
        case 'F2': {
          const one = chosen.length === 1 ? chosen[0] : null;
          if (one && writable && !one.partial) setRenaming({ entry: one, to: one.name });
          break;
        }
        case 'Delete': if (chosen.length && writable) confirmDelete(chosen); break;
        case 'n': case 'N': if (writable) setNewFolder(''); break;
        case 'g': case 'G': if (visual) setView(gridding ? 'list' : 'grid'); break;
        case '?': setShowKeys(true); break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // No dependency array on purpose. The handler closes over most of this
    // component's state, and listing them would be a list that goes stale
    // silently. Re-binding one listener per render costs nothing measurable.
  });

  // The path as a shell would take it, for pasting into a terminal or a
  // workflow. The clipboard API needs a secure context, which the console
  // is behind Caddy and on loopback; elsewhere the old selection trick.
  const copyPath = async (entry?: FsEntry) => {
    const rel = entry ? (path ? `${path}/${entry.name}` : entry.name) : path;
    const full = rel ? `${rootPath}/${rel}` : rootPath;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(full);
      } else {
        const box = document.createElement('textarea');
        box.value = full;
        box.style.position = 'fixed';
        box.style.opacity = '0';
        document.body.appendChild(box);
        box.select();
        document.execCommand('copy');
        box.remove();
      }
      message.success({ content: `已複製 ${full}`, duration: 2 });
    } catch {
      message.error('複製不了，瀏覽器不給剪貼簿');
    }
  };

  // ---- pieces ---------------------------------------------------------------------------------
  const menuFor = (entry: FsEntry): MenuProps['items'] => {
    const isFile = entry.kind === 'file' && !entry.partial;
    return [
      entry.kind === 'dir'
        ? { key: 'open', label: '打開', icon: <FolderOpenOutlined />, onClick: () => open(entry) }
        : isFile && entry.media === 'text'
          ? { key: 'edit', label: writable ? '編輯' : '檢視', icon: <FormOutlined />, onClick: () => open(entry) }
          : isFile ? { key: 'view', label: '檢視', icon: <FileOutlined />, onClick: () => open(entry) } : null,
      isFile ? { key: 'download', label: '下載', icon: <DownloadOutlined />,
                 onClick: () => window.open(fsRawUrl(root, path, entry.name, true), '_blank') } : null,
      { key: 'copy', label: '複製路徑', icon: <CopyOutlined />, onClick: () => void copyPath(entry) },
      { type: 'divider' },
      { key: 'rename', label: '重新命名', icon: <EditOutlined />, disabled: !writable || entry.partial,
        onClick: () => setRenaming({ entry, to: entry.name }) },
      { key: 'move', label: '移動…', icon: <FolderOpenOutlined />, disabled: !writable || entry.partial,
        onClick: () => setMoving(selected.includes(keyOf(entry)) ? chosen : [entry]) },
      { key: 'delete', label: '刪除', icon: <DeleteOutlined />, danger: true, disabled: !writable,
        onClick: () => confirmDelete(selected.includes(keyOf(entry)) ? chosen : [entry]) },
    ];
  };

  const crumbs = path ? path.split('/') : [];
  const groups: { title: string; key: FsRoot['group'] }[] = [
    { title: '推論引擎模型', key: 'llm' }, { title: 'ComfyUI', key: 'comfy' }, { title: '其他', key: 'other' },
  ];

  const rowStyle = (entry: FsEntry, isSelected: boolean): React.CSSProperties => ({
    display: 'grid', gridTemplateColumns: compact ? 'minmax(0, 1fr) 72px' : 'minmax(0, 1fr) 96px 110px', alignItems: 'center',
    gap: 12, padding: '0 12px', height: 32, cursor: 'default', userSelect: 'none',
    background: isSelected ? 'rgba(255,255,255,0.08)' : undefined,
    opacity: entry.kind === 'other' ? 0.45 : 1,
    borderRadius: 4,
  });

  return (
    <div style={{
      height: 'calc(100vh - 56px - 48px)', display: 'flex',
      border: `1px solid ${LINE.faint}`, borderRadius: 8, overflow: 'hidden',
      background: 'rgba(255,255,255,0.015)',
    }}>
      <input ref={picker} type="file" multiple hidden onChange={onPick} />

      {/* ---- locations ------------------------------------------------------- */}
      {locationsBeside && <aside style={{
        width: SIDEBAR_W, flex: 'none', borderRight: `1px solid ${LINE.faint}`,
        display: 'flex', flexDirection: 'column', minHeight: 0,
      }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 8px' }}>
          {groups.map((g) => {
            const members = roots.filter((r) => r.group === g.key);
            if (!members.length) return null;
            return (
              <div key={g.key} style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 10, letterSpacing: 1.2, display: 'block', padding: '4px 8px' }}>
                  {g.title}
                </Text>
                {members.map((r) => {
                  const current = r.key === root;
                  return (
                    <div
                      key={r.key}
                      role="button" tabIndex={0}
                      onClick={() => go(r.key, '')}
                      onKeyDown={(e) => { if (e.key === 'Enter') go(r.key, ''); }}
                      onDragOver={(e) => { if (acceptsDrop(e) && r.writable) { e.preventDefault(); } }}
                      onDrop={dropInto(r.key, '')}
                      title={`${r.note}\n${r.path}`}
                      className="fs-loc"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
                        borderRadius: 4, cursor: 'pointer', fontSize: 12,
                        background: current ? 'rgba(255,255,255,0.08)' : undefined,
                        opacity: r.exists ? 1 : 0.4,
                      }}
                    >
                      {r.key === 'home' || g.key === 'other' ? <HomeOutlined /> : <FolderOutlined />}
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.label}
                      </span>
                      {!r.writable && <Text type="secondary" style={{ fontSize: 9 }}>唯讀</Text>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Disk, then whatever is in flight. Under the locations so they are
            always in view, since an upload outlives the folder it started in. */}
        <div style={{ borderTop: `1px solid ${LINE.faint}`, padding: '10px 12px', fontSize: 11 }}>
          <Space size={6}>
            <HddOutlined style={{ opacity: 0.5 }} />
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>可用 {bytes(free)}</Text>
          </Space>
          {transfers.map((t) => (
            <div key={t.id} style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 11, fontFamily: MONO, flex: 1, minWidth: 0 }} ellipsis>{t.name}</Text>
                <Button size="small" type="text" icon={<CloseOutlined style={{ fontSize: 10 }} />}
                        onClick={() => {
                          if (t.error) setTransfers((prev) => prev.filter((x) => x.id !== t.id));
                          else t.abort.abort();
                        }} />
              </div>
              {t.error ? (
                <Text type="danger" style={{ fontSize: 10 }}>{t.error}</Text>
              ) : (
                <Progress percent={Math.floor(t.sent / t.size * 100)} size="small" showInfo={false}
                          strokeColor="rgba(255,255,255,0.7)" trailColor={LINE.faint} />
              )}
            </div>
          ))}
        </div>
      </aside>}

      {/* ---- main ------------------------------------------------------------ */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {tabs.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${LINE.faint}`,
            overflowX: 'auto', flex: 'none',
          }}>
            {[{ key: 'browser', name: '檔案', dirty: false }, ...tabs].map((t) => {
              const on = active === t.key;
              return (
                <div
                  key={t.key}
                  role="tab" tabIndex={0}
                  onClick={() => setActive(t.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setActive(t.key); }}
                  onAuxClick={(e) => { if (e.button === 1 && t.key !== 'browser') closeTab(t.key); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 34,
                    fontSize: 12, fontFamily: t.key === 'browser' ? undefined : MONO, cursor: 'pointer',
                    borderRight: `1px solid ${LINE.faint}`,
                    borderBottom: on ? '1px solid #fff' : '1px solid transparent',
                    marginBottom: -1, opacity: on ? 1 : 0.6, whiteSpace: 'nowrap',
                  }}
                >
                  {t.key === 'browser' ? <FolderOutlined /> : <FileTextOutlined />}
                  {t.name}
                  {t.key !== 'browser' && (
                    t.dirty
                      ? <span title="未儲存" style={{ width: 8, height: 8, borderRadius: '50%', background: ACCENT.warn }} />
                      : <CloseOutlined style={{ fontSize: 10, opacity: 0.6 }}
                                       onClick={(e) => { e.stopPropagation(); closeTab(t.key); }} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tabs.map((t) => (
          <Editor key={t.key} root={t.root} path={t.path} name={t.name} active={active === t.key}
                  onDirty={(d) => markDirty(t.key, d)} onSaved={reload} />
        ))}

        <div style={{ display: active === 'browser' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* crumbs + search */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
            borderBottom: `1px solid ${LINE.faint}`, flex: 'none',
          }}>
            {/* The locations list, when there is no room for it beside. */}
            {!locationsBeside && (
              <Select
                size="small"
                value={root}
                onChange={(key: string) => go(key, '')}
                options={roots.map((r) => ({ value: r.key, label: r.label }))}
                style={{ width: 120, flex: 'none' }}
                popupMatchSelectWidth={false}
              />
            )}
            {editingPath ? (
              <Input
                ref={pathInput}
                size="small"
                value={pathText}
                onChange={(e) => setPathText(e.target.value)}
                onPressEnter={() => void jump(pathText)}
                onBlur={() => setEditingPath(false)}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditingPath(false); }}
                style={{ fontFamily: MONO, fontSize: 12, flex: 1 }}
                placeholder="貼上絕對路徑，Enter 跳過去"
              />
            ) : (
              <div
                role="button" tabIndex={0}
                onClick={startEditingPath}
                onKeyDown={(e) => { if (e.key === 'Enter') startEditingPath(); }}
                title="點一下輸入路徑（Ctrl+L）"
                style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, cursor: 'text', height: 24, overflow: 'hidden' }}
              >
                <Crumb label={activeRoot?.label ?? root} onClick={() => setPath('')} last={!crumbs.length} />
                {crumbs.map((seg, i) => (
                  <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>›</Text>
                    <Crumb label={seg} last={i === crumbs.length - 1}
                           onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))} />
                  </span>
                ))}
              </div>
            )}
            <Input
              ref={search}
              size="small"
              allowClear
              prefix={<SearchOutlined style={{ opacity: 0.4 }} />}
              placeholder="搜尋這個資料夾（/）"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{ width: 220 }}
            />
          </div>

          {/* toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
            borderBottom: `1px solid ${LINE.faint}`, flex: 'none', minHeight: 40,
          }}>
            <Button size="small" icon={<UploadOutlined />} disabled={!writable}
                    onClick={() => picker.current?.click()}>上傳</Button>
            <Button size="small" icon={<FolderAddOutlined />} disabled={!writable}
                    onClick={() => setNewFolder('')}>新資料夾</Button>
            {visual && (
              <Segmented
                size="small"
                value={gridding ? 'grid' : 'list'}
                onChange={(v) => setView(v as 'list' | 'grid')}
                options={[
                  { value: 'list', icon: <UnorderedListOutlined /> },
                  { value: 'grid', icon: <AppstoreOutlined /> },
                ]}
              />
            )}
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, marginLeft: 4 }}>
              {loading ? '讀取中…' : `${total.toLocaleString()} 項${truncated ? `，只列出前 ${entries.length.toLocaleString()}` : ''}`}
            </Text>

            {/* One item's actions are in the details pane beside it; the
                toolbar repeats them only when that pane is closed, and
                always carries the ones that apply to several at once. */}
            {chosen.length > 0 && (
              <Space size={6} style={{ marginLeft: 'auto' }}>
                <Text type="secondary" style={{ fontSize: 11 }}>已選 {chosen.length}</Text>
                {!detailsOpen && chosen.length === 1 && chosen[0].kind === 'file' && !chosen[0].partial && (
                  <Button size="small" icon={<DownloadOutlined />}
                          href={fsRawUrl(root, path, chosen[0].name, true)}>下載</Button>
                )}
                {!detailsOpen && chosen.length === 1 && (
                  <Button size="small" icon={<EditOutlined />} disabled={!writable || chosen[0].partial}
                          onClick={() => setRenaming({ entry: chosen[0], to: chosen[0].name })}>重新命名</Button>
                )}
                {(!detailsOpen || chosen.length > 1) && (
                  <>
                    <Button size="small" icon={<FolderOpenOutlined />} disabled={!writable}
                            onClick={() => setMoving(chosen)}>移動</Button>
                    <Button size="small" danger icon={<DeleteOutlined />} disabled={!writable}
                            onClick={() => confirmDelete(chosen)}>刪除</Button>
                  </>
                )}
              </Space>
            )}
            <Space size={2} style={{ marginLeft: chosen.length ? 0 : 'auto' }}>
              <Tooltip title="重新整理">
                <Button size="small" type="text" icon={<ReloadOutlined />} onClick={reload} />
              </Tooltip>
              <Tooltip title={detailsOpen ? '收起詳細資料' : '顯示詳細資料'}>
                <Button size="small" type={detailsOpen ? 'default' : 'text'} icon={<InfoCircleOutlined />}
                        onClick={() => setDetailsOpen((v) => !v)} />
              </Tooltip>
              <Tooltip title="快捷鍵（?）">
                <Button size="small" type="text" icon={<QuestionCircleOutlined />} onClick={() => setShowKeys(true)} />
              </Tooltip>
            </Space>
          </div>

          {/* listing + details */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <Dropdown
              trigger={['contextMenu']}
              menu={{ items: [
                { key: 'copy', label: '複製這個資料夾的路徑', icon: <CopyOutlined />, onClick: () => void copyPath() },
                { key: 'new', label: '新資料夾', icon: <FolderAddOutlined />, disabled: !writable, onClick: () => setNewFolder('') },
                { key: 'upload', label: '上傳…', icon: <UploadOutlined />, disabled: !writable, onClick: () => picker.current?.click() },
              ] }}
            >
            <div
              style={{
                flex: 1, minWidth: 0, overflowY: 'auto', position: 'relative',
                outline: dragOver ? `2px dashed ${LINE.medium}` : 'none', outlineOffset: -4,
              }}
              onDragOver={(e) => { if (acceptsDrop(e)) { e.preventDefault(); if (writable) setDragOver(true); } }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
              onDrop={writable ? dropInto(root, path) : (e) => { e.preventDefault(); setDragOver(false); }}
              onClick={(e) => { if (e.target === e.currentTarget) setSelected([]); }}
            >
              {loading && !entries.length ? (
                <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}><Spin /></div>
              ) : !entries.length ? (
                <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
                  <Empty description={query ? '沒有符合的' : '空的資料夾'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                </div>
              ) : gridding ? (
                <div style={{
                  display: 'grid', gap: 10, padding: 12,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                }}>
                  {entries.map((entry) => {
                    const isSelected = selected.includes(keyOf(entry));
                    const thumb = entry.kind === 'file' && (entry.media === 'image' || entry.media === 'video');
                    return (
                      <Dropdown key={keyOf(entry)} menu={{ items: menuFor(entry) }} trigger={['contextMenu']}>
                        <div
                          draggable={writable && !entry.partial}
                          onDragStart={startDrag(entry)}
                          onClick={(e) => { e.stopPropagation(); pick(entry, e); }}
                          onDoubleClick={() => open(entry)}
                          onContextMenu={(e) => { e.stopPropagation(); if (!isSelected) { setSelected([keyOf(entry)]); anchor.current = keyOf(entry); } }}
                          onDragOver={entry.kind === 'dir' ? (e) => { if (acceptsDrop(e)) { e.preventDefault(); e.stopPropagation(); } } : undefined}
                          onDrop={entry.kind === 'dir' ? dropInto(root, path ? `${path}/${entry.name}` : entry.name) : undefined}
                          className="fs-tile"
                          style={{
                            borderRadius: 6, padding: 6, cursor: 'default', userSelect: 'none',
                            background: isSelected ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.02)',
                            border: `1px solid ${isSelected ? LINE.medium : LINE.faint}`,
                          }}
                        >
                          <div style={{
                            aspectRatio: '1 / 1', borderRadius: 4, overflow: 'hidden', background: '#000',
                            display: 'grid', placeItems: 'center', fontSize: 28, opacity: thumb ? 1 : 0.35,
                          }}>
                            {thumb
                              ? <img src={fsThumbUrl(root, path, entry.name)} alt="" loading="lazy"
                                     style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              : iconFor(entry)}
                          </div>
                          <Text style={{ fontSize: 11, fontFamily: MONO, display: 'block', marginTop: 6 }} ellipsis title={entry.name}>
                            {entry.name}
                          </Text>
                        </div>
                      </Dropdown>
                    );
                  })}
                </div>
              ) : (
                <div style={{ padding: '4px 6px' }}>
                  <div style={{ ...rowStyle({ kind: 'dir' } as FsEntry, false), height: 26, cursor: 'default' }}>
                    <Text type="secondary" style={{ fontSize: 10, letterSpacing: 1.2 }}>名稱</Text>
                    <Text type="secondary" style={{ fontSize: 10, letterSpacing: 1.2, textAlign: 'right' }}>大小</Text>
                    {!compact && <Text type="secondary" style={{ fontSize: 10, letterSpacing: 1.2, textAlign: 'right' }}>修改時間</Text>}
                  </div>
                  {entries.map((entry) => {
                    const isSelected = selected.includes(keyOf(entry));
                    const measured = sizes[at(entry.name)];
                    return (
                      <Dropdown key={keyOf(entry)} menu={{ items: menuFor(entry) }} trigger={['contextMenu']}>
                        <div
                          draggable={writable && !entry.partial}
                          onDragStart={startDrag(entry)}
                          onClick={(e) => { e.stopPropagation(); pick(entry, e); }}
                          onDoubleClick={() => open(entry)}
                          onContextMenu={(e) => { e.stopPropagation(); if (!isSelected) { setSelected([keyOf(entry)]); anchor.current = keyOf(entry); } }}
                          onDragOver={entry.kind === 'dir' ? (e) => { if (acceptsDrop(e)) { e.preventDefault(); e.stopPropagation(); } } : undefined}
                          onDrop={entry.kind === 'dir' ? dropInto(root, path ? `${path}/${entry.name}` : entry.name) : undefined}
                          className="fs-row"
                          style={rowStyle(entry, isSelected)}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <span style={{ opacity: 0.55, fontSize: 13, flex: 'none' }}>{iconFor(entry)}</span>
                            <Text style={{ fontSize: 12, fontFamily: MONO }} ellipsis>{entry.name}</Text>
                            {entry.partial && <Tag color="gold" style={{ fontSize: 10, marginInlineEnd: 0 }}>未完成</Tag>}
                          </span>
                          <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, textAlign: 'right' }}>
                            {entry.kind === 'dir'
                              ? (measured && measured !== 'working' ? bytes(measured.bytes) : '—')
                              : entry.size !== null ? bytes(entry.size) : ''}
                          </Text>
                          {!compact && (
                            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, textAlign: 'right' }}>
                              {when(entry.modified)}
                            </Text>
                          )}
                        </div>
                      </Dropdown>
                    );
                  })}
                </div>
              )}
            </div>
            </Dropdown>

            {detailsOpen && (() => {
              const details = (
                <Details
                  root={root} rootPath={rootPath} path={path} entries={entries} chosen={chosen}
                  writable={writable} free={free} total={total} sizes={sizes}
                  onMeasure={(name) => void measure(name)}
                  onOpen={open}
                  onView={(entry) => setViewing(entries.indexOf(entry))}
                  onRename={(entry) => setRenaming({ entry, to: entry.name })}
                  onMove={(items) => setMoving(items)}
                  onDelete={confirmDelete}
                  onCopyPath={(entry) => void copyPath(entry)}
                />
              );
              return detailsBeside ? (
                <div style={{ width: DETAILS_W, flex: 'none', borderLeft: `1px solid ${LINE.faint}`, overflowY: 'auto' }}>
                  {details}
                </div>
              ) : (
                <Drawer open onClose={() => setDetailsOpen(false)} placement="right"
                        width={Math.min(DETAILS_W + 40, window.innerWidth - 24)}
                        title="詳細資料" styles={{ body: { padding: 0 } }}>
                  {details}
                </Drawer>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ---- dialogs ------------------------------------------------------------- */}
      {viewing !== null && entries[viewing] && (
        <FilePreview
          root={root} path={path} entries={entries} index={viewing}
          onIndex={setViewing} onClose={() => setViewing(null)}
          onEdit={writable ? (name) => {
            const hit = entries.find((e) => e.name === name);
            setViewing(null);
            if (hit) openEditor(hit);
          } : undefined}
        />
      )}
      {moving && (
        <FolderPicker
          roots={roots} fromRoot={root} fromPath={path} title={`移動 ${moving.length} 項到…`}
          moving={moving.map((e) => e.name)}
          onPick={(toRoot, toPath) => moveTo(moving, toRoot, toPath)}
          onCancel={() => setMoving(null)}
        />
      )}
      <Modal
        open={newFolder !== null}
        title="新資料夾"
        okText="建立" cancelText="取消"
        confirmLoading={busy}
        onOk={() => void onCreateFolder()}
        onCancel={() => setNewFolder(null)}
        destroyOnHidden
      >
        <Input autoFocus value={newFolder ?? ''} onChange={(e) => setNewFolder(e.target.value)}
               onPressEnter={() => void onCreateFolder()} placeholder="名稱" style={{ fontFamily: MONO }} />
      </Modal>
      <Modal
        open={renaming !== null}
        title="重新命名"
        okText="改名" cancelText="取消"
        confirmLoading={busy}
        onOk={() => void onRename()}
        onCancel={() => setRenaming(null)}
        destroyOnHidden
      >
        <Input autoFocus value={renaming?.to ?? ''}
               onChange={(e) => setRenaming((r) => (r ? { ...r, to: e.target.value } : r))}
               onPressEnter={() => void onRename()} style={{ fontFamily: MONO }} />
      </Modal>
      <Modal open={showKeys} title="快捷鍵" footer={null} onCancel={() => setShowKeys(false)}>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', fontSize: 12 }}>
          {SHORTCUTS.map(([key, what]) => (
            <span key={key} style={{ display: 'contents' }}>
              <Text code style={{ fontSize: 11 }}>{key}</Text>
              <Text style={{ fontSize: 12 }}>{what}</Text>
            </span>
          ))}
        </div>
      </Modal>
    </div>
  );
}

function Crumb({ label, last, onClick }: { label: string; last: boolean; onClick: () => void }) {
  return (
    <span
      role="button" tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onClick(); } }}
      style={{
        fontSize: 12, fontFamily: MONO, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
        opacity: last ? 1 : 0.65, whiteSpace: 'nowrap',
      }}
      className="fs-crumb"
    >
      {label}
    </span>
  );
}
