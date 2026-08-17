import { useCallback, useEffect, useState } from 'react';
import { Breadcrumb, Empty, List, Modal, Segmented, Space, Spin, Typography } from 'antd';
import { FolderOutlined } from '@ant-design/icons';
import { fetchFsListing, type FsRoot } from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

/**
 * Choose a directory.
 *
 * Deliberately a navigator rather than a tree. A tree of a home directory has
 * to either load lazily -- which is the same navigation with more state -- or
 * walk the disk to draw itself, which is exactly the cost the listing was
 * changed to stop paying. Walking one level at a time is also what the person
 * doing it is already used to from the page behind this dialog.
 *
 * Only directories appear: files are not destinations, and showing them would
 * fill the list with the thing that cannot be chosen.
 */

interface Props {
  roots: FsRoot[];
  /** Where to start, which is nearly always where the files are now. */
  fromRoot: string;
  fromPath: string;
  title: string;
  /** Names in the source directory being moved. A directory cannot be moved
   *  into itself, and the resulting subtree would be unreachable with no error
   *  to say so, which is the worst combination available. */
  moving?: string[];
  onPick: (root: string, path: string) => void;
  onCancel: () => void;
}

export default function FolderPicker({
  roots, fromRoot, fromPath, title, moving = [], onPick, onCancel,
}: Props) {
  const [root, setRoot] = useState(fromRoot);
  const [path, setPath] = useState(fromPath);
  const [folders, setFolders] = useState<string[]>([]);
  const [writable, setWritable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const segments = path ? path.split('/') : [];
  const activeRoot = roots.find((r) => r.key === root);
  const unchanged = root === fromRoot && path === fromPath;

  const load = useCallback(async (key: string, where: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchFsListing(key, where);
      setFolders(data.entries.filter((e) => e.kind === 'dir').map((e) => e.name));
      setWritable(data.writable);
    } catch (err) {
      setError((err as Error).message);
      setFolders([]);
      setWritable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(root, path); }, [root, path, load]);

  // Descending into something being moved is the one navigation that cannot
  // lead anywhere valid, so it is refused where it is offered rather than
  // where it is submitted.
  const forbidden = (name: string) =>
    root === fromRoot && path === fromPath && moving.includes(name);

  return (
    <Modal
      open
      title={title}
      okText="移到這裡"
      cancelText="取消"
      onOk={() => onPick(root, path)}
      onCancel={onCancel}
      okButtonProps={{ disabled: !writable || unchanged }}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Segmented
          size="small"
          value={root}
          onChange={(v) => { setRoot(v as string); setPath(''); }}
          options={roots.filter((r) => r.exists).map((r) => ({ label: r.label, value: r.key }))}
        />

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

        <div style={{ height: 260, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4 }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 90 }}><Spin size="small" /></div>
          ) : error ? (
            <div style={{ padding: 20 }}>
              <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>
            </div>
          ) : folders.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="沒有子資料夾"
              style={{ marginTop: 80 }}
            />
          ) : (
            <List
              size="small"
              dataSource={folders}
              renderItem={(name) => (
                <List.Item
                  style={{
                    padding: '5px 12px',
                    cursor: forbidden(name) ? 'not-allowed' : 'pointer',
                    opacity: forbidden(name) ? 0.35 : 1,
                  }}
                  onClick={() => {
                    if (!forbidden(name)) setPath(path ? `${path}/${name}` : name);
                  }}
                >
                  <Space size={8}>
                    <FolderOutlined style={{ fontSize: 11, opacity: 0.5 }} />
                    <Text style={{ fontSize: 12, fontFamily: MONO }}>{name}</Text>
                  </Space>
                </List.Item>
              )}
            />
          )}
        </div>

        {!writable && !loading && !error && (
          <Text type="warning" style={{ fontSize: 11 }}>這個位置寫不進去。</Text>
        )}
        {unchanged && writable && (
          <Text type="secondary" style={{ fontSize: 11 }}>檔案已經在這裡了。</Text>
        )}
      </Space>
    </Modal>
  );
}
