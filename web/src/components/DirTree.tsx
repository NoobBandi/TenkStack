/**
 * The directory hierarchy, as a tree you can jump around in.
 *
 * The path bar answers "where am I" and lets you go up; neither of those is the
 * same as going somewhere else. Reaching a sibling three levels down meant
 * walking up through the listing and back down through it, one directory read
 * per step, with the destination invisible until the last one. A tree is the
 * shape that has always solved this, and it is the last of the three panes a
 * file manager is conventionally made of.
 *
 * Children load when a node is opened, never before. A models root holds tens
 * of thousands of files, and a tree that eagerly walked it would spend the
 * first minute reading directories nobody asked about -- so this asks for one
 * level at a time and keeps what it has been given.
 *
 * Only directories appear. The listing beside it is where files are chosen; a
 * tree carrying both would duplicate that and bury the structure it exists to
 * show.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, Tree, Typography } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { FolderOpenOutlined, FolderOutlined } from '@ant-design/icons';
import { fetchFsListing } from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

interface Props {
  root: string;
  /** The directory the listing is showing, so the tree can follow it. */
  path: string;
  onNavigate: (path: string) => void;
  /** Bumped by the page when a directory is created, renamed or deleted, so the
   *  branch holding it is re-read instead of showing what used to be there. */
  refreshToken?: number;
}

function nodeFor(path: string, name: string): DataNode {
  return {
    key: path,
    title: <Text style={{ fontSize: 12, fontFamily: MONO }}>{name}</Text>,
    icon: ({ expanded }: { expanded?: boolean }) => (
      expanded ? <FolderOpenOutlined /> : <FolderOutlined />
    ),
    // Assumed to have children until opening proves otherwise. The alternative
    // is a listing per directory just to decide whether to draw an arrow, which
    // is the eager walk this design exists to avoid. A node that turns out to be
    // empty loses its arrow on the first open.
    isLeaf: false,
  };
}

export default function DirTree({ root, path, onNavigate, refreshToken = 0 }: Props) {
  const [nodes, setNodes] = useState<DataNode[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Every ancestor of the current path, so following the listing opens the
  // branch rather than selecting something invisible inside a closed one.
  const ancestors = useMemo(() => {
    const parts = path ? path.split('/') : [];
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  }, [path]);

  const read = useCallback(async (at: string): Promise<DataNode[]> => {
    const listing = await fetchFsListing(root, at, false, '');
    return listing.entries
      .filter((e) => e.kind === 'dir')
      .map((e) => nodeFor(at ? `${at}/${e.name}` : e.name, e.name));
  }, [root]);

  // The root's own children. Reset rather than merged when the root changes:
  // keys are paths relative to a root, so keeping them across a switch would
  // graft one tree's branches onto another.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setNodes([]);
    setExpanded([]);
    read('')
      .then((children) => { if (live) setNodes(children); })
      .catch(() => { if (live) setNodes([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [read, refreshToken]);

  const onLoad = useCallback(async (node: DataNode) => {
    const children = await read(String(node.key)).catch(() => [] as DataNode[]);
    setNodes((current) => {
      const graft = (list: DataNode[]): DataNode[] => list.map((n) => {
        if (n.key === node.key) {
          // No children is the answer, not a failure: mark it a leaf so the
          // arrow goes away and opening it again costs nothing.
          return children.length ? { ...n, children } : { ...n, isLeaf: true };
        }
        return n.children ? { ...n, children: graft(n.children) } : n;
      });
      return graft(current);
    });
  }, [read]);

  // Follow the listing into directories reached by other means -- a double
  // click, the path bar, a search result -- so the two panes never disagree
  // about where you are.
  useEffect(() => {
    setExpanded((current) => {
      const missing = ancestors.filter((a) => !current.includes(a));
      return missing.length ? [...current, ...missing] : current;
    });
  }, [ancestors]);

  if (!loading && nodes.length === 0) {
    return (
      <div style={{ padding: '18px 8px' }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary" style={{ fontSize: 11 }}>沒有子目錄</Text>}
        />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', paddingInlineEnd: 8 }}>
      <Tree
        showIcon
        blockNode
        treeData={nodes}
        loadData={onLoad}
        expandedKeys={expanded}
        onExpand={(keys) => setExpanded(keys as string[])}
        selectedKeys={[path]}
        onSelect={(keys) => {
          // Selecting the already-selected node deselects in antd, which would
          // leave the tree pointing nowhere while the listing had not moved.
          if (keys.length) onNavigate(String(keys[0]));
        }}
      />
    </div>
  );
}
