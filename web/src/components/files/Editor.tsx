import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Spin, Tag, Typography } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import type * as monacoNs from 'monaco-editor';
import { fetchFsText, saveFsText, type FsText } from '../../api';
import { LINE, MONO } from '../../theme';
import { bytes, suffixOf } from './kit';
import { loadMonaco, monacoLanguage } from './monaco';

const { Text } = Typography;

/**
 * One open file, in a tab of the file manager.
 *
 * It reads /api/fs/text, not /peek. The preview is served a truncated head,
 * which is right for looking and catastrophic for saving -- writing that
 * prefix back would delete everything after it. The text route refuses
 * anything it cannot hand over whole, so what is on screen is always the
 * entire file.
 *
 * The editor stays mounted while its tab is in the background, hidden rather
 * than unmounted: Monaco holds the undo stack, the cursor and the scroll
 * position, and a tab that forgot all three on every switch would not be a
 * tab.
 */

interface Props {
  root: string;
  path: string;
  name: string;
  active: boolean;
  onDirty: (dirty: boolean) => void;
  /** After a successful save, so the listing's size and time catch up. */
  onSaved: () => void;
}

export default function Editor({ root, path, name, active, onDirty, onSaved }: Props) {
  const { message, modal } = AntApp.useApp();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null);
  const [file, setFile] = useState<FsText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // The text as last read or saved, for the dirty check and for the save.
  const baseline = useRef('');
  const mtime = useRef<number | null>(null);
  // The parent hands new closures on every render; held in refs so that a
  // re-render of the tab strip does not re-read the file.
  const tell = useRef({ onDirty, onSaved });
  tell.current = { onDirty, onSaved };

  const load = useCallback(async () => {
    setError(null);
    try {
      const found = await fetchFsText(root, path, name);
      setFile(found);
      baseline.current = found.text;
      mtime.current = found.mtime;
      editor.current?.setValue(found.text);
      setDirty(false);
      tell.current.onDirty(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [root, path, name]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    const ed = editor.current;
    if (!ed || !file || !file.writable) return;
    const text = ed.getValue();
    setSaving(true);
    try {
      const result = await saveFsText(root, path, name, text, mtime.current);
      baseline.current = text;
      mtime.current = result.mtime;
      setFile((prev) => (prev ? { ...prev, size: result.size, mtime: result.mtime } : prev));
      setDirty(false);
      tell.current.onDirty(false);
      message.success(`${name} 已儲存`);
      tell.current.onSaved();
    } catch (e) {
      const detail = (e as Error).message;
      // The backend refuses a save over a file that changed since it was
      // read. Offer the two honest ways out; never overwrite quietly.
      if (/409|changed|改變|已被/.test(detail)) {
        modal.confirm({
          title: '檔案在磁碟上已經被改過',
          content: '這份是舊的內容。要用你的版本蓋掉磁碟上的，還是丟掉你的修改重新載入？',
          okText: '用我的蓋掉', cancelText: '重新載入', okButtonProps: { danger: true },
          onOk: async () => {
            const forced = await saveFsText(root, path, name, text, null);
            baseline.current = text;
            mtime.current = forced.mtime;
            setDirty(false);
            tell.current.onDirty(false);
            tell.current.onSaved();
          },
          onCancel: () => void load(),
        });
      } else {
        message.error(`儲存失敗：${detail}`);
      }
    } finally {
      setSaving(false);
    }
  }, [file, root, path, name, message, modal, load]);

  // Create the editor once the file and Monaco are both here.
  useEffect(() => {
    if (!file || !host.current || editor.current) return;
    let disposed = false;
    void loadMonaco().then((monaco) => {
      if (disposed || !host.current) return;
      const ed = monaco.editor.create(host.current, {
        value: file.text,
        language: monacoLanguage(suffixOf(name), name),
        theme: 'tenkstack',
        readOnly: !file.writable,
        automaticLayout: true,
        fontFamily: MONO,
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: file.text.length > 20000 },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        wordWrap: 'off',
        tabSize: 2,
        padding: { top: 12 },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        renderWhitespace: 'selection',
        bracketPairColorization: { enabled: true },
      });
      ed.onDidChangeModelContent(() => {
        const now = ed.getValue() !== baseline.current;
        setDirty(now);
        tell.current.onDirty(now);
      });
      editor.current = ed;
    });
    return () => {
      disposed = true;
      editor.current?.dispose();
      editor.current = null;
    };
    // The editor is created once per file; content changes go through
    // setValue in load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file === null]);

  // Ctrl+S from inside the editor. Bound at the window rather than through
  // Monaco's keybinding service so it also works when the focus is on the
  // toolbar; Monaco's own would only fire with the cursor in the text.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, save]);

  useEffect(() => {
    if (active) editor.current?.focus();
  }, [active]);

  return (
    <div style={{
      display: active ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px',
        borderBottom: `1px solid ${LINE.faint}`, flex: 'none',
      }}>
        <Text style={{ fontSize: 12, fontFamily: MONO }} ellipsis>
          {path ? `${path}/` : ''}{name}
        </Text>
        {file && (
          <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, whiteSpace: 'nowrap' }}>
            {bytes(file.size)} ・ {monacoLanguage(suffixOf(name), name)}
          </Text>
        )}
        {file && !file.writable && <Tag style={{ fontSize: 10 }}>唯讀</Tag>}
        <span style={{ marginLeft: 'auto' }} />
        <Text type="secondary" style={{ fontSize: 11 }}>
          {dirty ? '未儲存' : file ? '已儲存' : ''}
        </Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => {
          if (dirty) {
            modal.confirm({
              title: '丟掉修改重新載入？', okText: '重新載入', cancelText: '取消',
              onOk: () => void load(),
            });
          } else {
            void load();
          }
        }}>
          重新載入
        </Button>
        <Button size="small" type="primary" ghost icon={<SaveOutlined />}
                loading={saving} disabled={!dirty || !file?.writable}
                onClick={() => void save()}>
          儲存
        </Button>
      </div>

      {error ? (
        <div style={{ padding: 24 }}>
          <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>
        </div>
      ) : !file ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}><Spin /></div>
      ) : null}
      {/* Always in the tree once the file is here, so Monaco has a box to
          measure; hidden while an error is showing. */}
      <div ref={host} style={{ flex: 1, minHeight: 0, display: file && !error ? 'block' : 'none' }} />
    </div>
  );
}

// Named so the tab strip can ask before closing a dirty one.
export type { Props as EditorProps };
