import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Descriptions, Empty, Image, Modal, Segmented, Space, Spin, Switch, Tag, Typography,
} from 'antd';
import {
  DownloadOutlined, FormOutlined, LeftOutlined, RightOutlined,
} from '@ant-design/icons';
import { fetchFsPeek, fsRawUrl, type FsEntry, type FsPeek } from '../api';
import { MONO } from '../theme';
import Markdown from './Markdown';
import CodeView from './CodeView';
import TensorTable from './TensorTable';

const { Text } = Typography;

/**
 * What one file is, without leaving the browser.
 *
 * A file manager that can only list and delete makes you download something to
 * find out whether it is the thing you meant. Four kinds of answer cover almost
 * everything that lands on this machine:
 *
 * - pictures and video, which are what ComfyUI produces;
 * - text, which is what workflows, configs and scripts are;
 * - model headers, which are the interesting part of a 20 GB file and are all
 *   in its first few hundred kilobytes;
 * - and, honestly, nothing, for a binary that has nothing to show.
 *
 * The bytes come from /api/fs/raw, which serves images, video and audio inline
 * and everything else as an attachment. That distinction is the security
 * boundary: an HTML file rendered inline from this origin would run script
 * against the session that opened it.
 */

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

/** 1.07e9 is unreadable and 1066247386 is worse. */
function parameters(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  return n.toLocaleString();
}

const MEDIA_STYLE: React.CSSProperties = {
  maxWidth: '100%', maxHeight: '68vh', display: 'block', margin: '0 auto',
};

interface Props {
  root: string;
  path: string;
  /** The whole directory, so the arrows can step through it. */
  entries: FsEntry[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Opens the editor on this file. Absent for a root that cannot be written,
   *  so the button is missing rather than present and refusing. */
  onEdit?: (name: string) => void;
}

export default function FilePreview(
  { root, path, entries, index, onIndex, onClose, onEdit }: Props,
) {
  const entry = entries[index];
  const [peek, setPeek] = useState<FsPeek | null>(null);
  const [loading, setLoading] = useState(false);

  // Only files worth opening participate in the arrows. Stepping onto a folder
  // or a socket would close the panel it is meant to move within.
  const stops = useMemo(
    () => entries.map((e, i) => (e.kind === 'file' && !e.partial ? i : -1)).filter((i) => i >= 0),
    [entries],
  );
  const at = stops.indexOf(index);
  const step = useCallback((delta: number) => {
    if (at < 0) return;
    const next = stops[at + delta];
    if (next !== undefined) onIndex(next);
  }, [at, stops, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  // Text and model headers need a request; pictures and video do not, because
  // the element fetches its own bytes.
  const wantsPeek = entry && (entry.media === 'text' || entry.media === 'model' || !entry.media);
  useEffect(() => {
    if (!entry || !wantsPeek) { setPeek(null); return; }
    let live = true;
    setLoading(true);
    setPeek(null);
    fetchFsPeek(root, path, entry.name)
      .then((data) => { if (live) setPeek(data); })
      .catch(() => { if (live) setPeek(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [root, path, entry, wantsPeek]);

  if (!entry) return null;
  const src = fsRawUrl(root, path, entry.name);

  // A dialog rather than a drawer or a pane. Looking at a file is a thing you
  // stop to do, and the two alternatives both got it wrong in opposite
  // directions: a drawer covered the listing without earning the space, and a
  // pane kept the listing visible but gave the file a column instead of a
  // window. A dialog is what every file manager reaches for, and it is the only
  // one of the three wide enough that editing in it is not cramped.
  return (
    <Modal
      open
      onCancel={onClose}
      width="min(1180px, 94vw)"
      styles={{ body: { height: '74vh', display: 'flex', flexDirection: 'column', minHeight: 0 } }}
      title={
        <Space size={10} style={{ minWidth: 0 }}>
          <Text style={{ fontSize: 13, fontFamily: MONO }} ellipsis>{entry.name}</Text>
          <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, whiteSpace: 'nowrap' }}>
            {bytes(entry.size ?? 0)}
          </Text>
        </Space>
      }
      footer={
        <Space>
          <Button
            size="small" type="text" icon={<LeftOutlined />}
            disabled={at <= 0} onClick={() => step(-1)}
          />
          <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
            {at >= 0 ? `${at + 1} / ${stops.length}` : ''}
          </Text>
          <Button
            size="small" type="text" icon={<RightOutlined />}
            disabled={at < 0 || at >= stops.length - 1} onClick={() => step(1)}
          />
          {/* A link rather than a fetch: the browser's own download manager
              handles a 20 GB file, and nothing has to hold it in memory. */}
          <Button
            size="small" icon={<DownloadOutlined />} style={{ marginInlineStart: 12 }}
            href={fsRawUrl(root, path, entry.name, true)}
          >
            下載
          </Button>
          {entry.media === 'text' && onEdit && (
            <Button size="small" type="primary" ghost icon={<FormOutlined />}
              onClick={() => onEdit(entry.name)}>
              編輯
            </Button>
          )}
          <Button size="small" onClick={onClose}>關閉</Button>
        </Space>
      }
    >
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <Body entry={entry} src={src} peek={peek} loading={loading} />
      </div>
    </Modal>
  );
}

function Body({ entry, src, peek, loading }: {
  entry: FsEntry; src: string; peek: FsPeek | null; loading: boolean;
}) {
  if (entry.partial) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="這是還沒傳完的檔案，內容不完整"
      />
    );
  }

  if (entry.media === 'image') {
    // antd's Image carries the zoom, rotate and flip toolbar, so a full-size
    // viewer costs nothing beyond using it.
    return <Image src={src} style={MEDIA_STYLE} placeholder />;
  }
  if (entry.media === 'video') {
    // The server answers Range with 206, which is the only reason the scrubber
    // works rather than playing from the start or not at all.
    return <video src={src} controls style={MEDIA_STYLE} />;
  }
  if (entry.media === 'audio') {
    return <audio src={src} controls style={{ width: '100%' }} />;
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>;
  }
  if (!peek) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="這個檔案沒有可顯示的內容" />;
  }
  if (peek.kind === 'text') return <TextBody peek={peek} name={entry.name} />;
  if (peek.kind === 'model') return <ModelBody peek={peek} />;
  if (peek.kind === 'unreadable') {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={<Text type="secondary" style={{ fontSize: 12 }}>{peek.detail}</Text>}
      />
    );
  }
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={`二進位檔案，${bytes(peek.size)}。用上面的「下載」取回。`}
    />
  );
}

function TextBody({ peek, name }: { peek: Extract<FsPeek, { kind: 'text' }>; name: string }) {
  // Two readers, because .md has two audiences. A README is prose and wants to
  // be read as prose; the same file being edited is source and wants line
  // numbers. Everything else has only ever been source.
  const isMarkdown = name.toLowerCase().endsWith('.md');
  const [asSource, setAsSource] = useState(!isMarkdown);
  const [wrap, setWrap] = useState(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Space size={10} style={{ marginBottom: 8, flexWrap: 'wrap' }}>
        {isMarkdown && (
          <Segmented
            size="small"
            value={asSource ? 'source' : 'rendered'}
            onChange={(v) => setAsSource(v === 'source')}
            options={[{ label: '排版', value: 'rendered' }, { label: '原始碼', value: 'source' }]}
          />
        )}
        {asSource && (
          <Space size={5}>
            <Text type="secondary" style={{ fontSize: 11 }}>換行</Text>
            <Switch size="small" checked={wrap} onChange={setWrap} />
          </Space>
        )}
        {asSource && (
          <Text type="secondary" style={{ fontSize: 11 }}>Ctrl+F 在檔案內搜尋</Text>
        )}
        {peek.truncated && (
          <Text type="warning" style={{ fontSize: 11 }}>
            檔案 {bytes(peek.size)}，只讀了開頭 256 KiB
          </Text>
        )}
      </Space>
      <div style={{ flex: 1, minHeight: 0 }}>
        {asSource
          ? <CodeView text={peek.text} suffix={peek.language} wrap={wrap} />
          : <Markdown>{peek.text}</Markdown>}
      </div>
    </div>
  );
}

function ModelBody({ peek }: { peek: Extract<FsPeek, { kind: 'model' }> }) {
  const meta = (peek.metadata ?? {}) as Record<string, unknown>;
  // Checkpoints in the modelspec convention carry their own preview picture as
  // a data URI. It is the single most useful thing in the header and would be
  // buried as a 40 KB string in the metadata table.
  const thumbnail = typeof meta['modelspec.thumbnail'] === 'string'
    ? (meta['modelspec.thumbnail'] as string)
    : null;
  const rest = Object.entries(meta).filter(([k]) => k !== 'modelspec.thumbnail');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Tag color="blue">{peek.format}</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>{bytes(peek.size)}</Text>
        <Text type="secondary" style={{ fontSize: 12 }}>{peek.count} 個張量</Text>
        {peek.format === 'safetensors' && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            約 {parameters(peek.parameters)} 參數
          </Text>
        )}
      </Space>

      {thumbnail && (
        <Image src={thumbnail} style={{ maxWidth: 260, borderRadius: 4 }} />
      )}

      {rest.length > 0 && (
        <Descriptions
          size="small" column={1} bordered
          styles={{ label: { width: 220, fontSize: 11 }, content: { fontSize: 11 } }}
          items={rest.map(([key, value]) => ({
            key,
            label: <span style={{ fontFamily: MONO }}>{key}</span>,
            children: (
              <span style={{ fontFamily: MONO, wordBreak: 'break-all' }}>
                {typeof value === 'object' ? JSON.stringify(value) : String(value)}
              </span>
            ),
          }))}
        />
      )}

      {peek.tensors && peek.tensors.length > 0 && (
        <TensorTable tensors={peek.tensors} truncated={peek.truncated} />
      )}

    </Space>
  );
}
