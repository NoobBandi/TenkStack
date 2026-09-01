/**
 * Editing one text file, in a window of its own.
 *
 * Separate from the preview pane on purpose. A preview is something you glance
 * at while moving through a directory -- it changes as the selection changes,
 * and losing what it showed costs nothing. An edit is a piece of work with a
 * beginning and an end, and it must not be thrown away because an arrow key
 * moved the selection underneath it. So this is modal: while it is open, it is
 * what you are doing.
 *
 * It reads /api/fs/text, not /peek. The preview is served a truncated head,
 * which is right for looking and catastrophic for saving -- writing that prefix
 * back would delete everything after it. The text route refuses anything it
 * cannot hand over whole, so what is on screen is always the entire file.
 */
import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Modal, Space, Spin, Tag, Typography } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import { fetchFsText, saveFsText, type FsText } from '../api';
import { MONO } from '../theme';
import CodeView from './CodeView';

const { Text } = Typography;

interface Props {
  root: string;
  path: string;
  name: string;
  onClose: () => void;
  /** Called after a successful save, so the listing's size and time catch up. */
  onSaved?: () => void;
}

export default function FileEditor({ root, path, name, onClose, onSaved }: Props) {
  const { message, modal } = AntApp.useApp();
  const [file, setFile] = useState<FsText | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = file !== null && text !== file.text;

  useEffect(() => {
    let live = true;
    setFile(null);
    setError(null);
    fetchFsText(root, path, name)
      .then((data) => { if (live) { setFile(data); setText(data.text); } })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [root, path, name]);

  const save = useCallback(async () => {
    if (!file || !dirty) return;
    setSaving(true);
    try {
      const result = await saveFsText(root, path, name, text, file.mtime);
      // The new mtime replaces the old one, so a second save in the same
      // sitting is not refused as a conflict with the version we just wrote.
      setFile({ ...file, text, size: result.size, mtime: result.mtime });
      message.success('已儲存');
      onSaved?.();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [file, dirty, root, path, name, text, message, onSaved]);

  const close = useCallback(() => {
    if (!dirty) { onClose(); return; }
    modal.confirm({
      title: '關閉而不儲存？',
      content: `${name} 有未儲存的修改。`,
      okText: '丟棄修改',
      okButtonProps: { danger: true },
      cancelText: '繼續編輯',
      onOk: onClose,
    });
  }, [dirty, modal, name, onClose]);

  // Ctrl/Cmd-S, because every editor has it and its absence is felt as a bug.
  // Captured on the window rather than inside CodeMirror so it works while the
  // focus is on the toolbar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  return (
    <Modal
      open
      onCancel={close}
      width="min(1100px, 94vw)"
      // Tall and fixed, so the editor has a height to measure and the window
      // does not resize itself as the file grows under the cursor.
      styles={{ body: { height: '72vh', display: 'flex', flexDirection: 'column', minHeight: 0 } }}
      title={
        <Space size={10}>
          <Text style={{ fontSize: 13, fontFamily: MONO }}>{name}</Text>
          {dirty && <Tag color="gold">未儲存</Tag>}
          {file && !file.writable && <Tag>唯讀</Tag>}
        </Space>
      }
      footer={
        <Space>
          <Text type="secondary" style={{ fontSize: 11, marginInlineEnd: 'auto' }}>
            Ctrl+S 儲存 ・ Ctrl+F 搜尋
          </Text>
          <Button onClick={close}>關閉</Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!dirty || !file?.writable}
            onClick={() => void save()}
          >
            儲存
          </Button>
        </Space>
      }
    >
      {error ? (
        <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>
      ) : !file ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <CodeView
            text={file.text}
            suffix={file.language}
            // Editable only when the directory takes writes. A read-only file
            // opened in a typable editor is a promise the save button cannot
            // keep.
            onChange={file.writable ? setText : undefined}
          />
        </div>
      )}
    </Modal>
  );
}
