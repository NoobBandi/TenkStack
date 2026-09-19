import { useEffect, useState } from 'react';
import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import {
  CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, ExpandOutlined, FormOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons';
import { fetchFsPeek, fsRawUrl, fsThumbUrl, type FsEntry, type FsPeek } from '../../api';
import { LINE, MONO } from '../../theme';
import { bytes, whenLong, type Measured } from './kit';

const { Text } = Typography;

/**
 * The pane on the right: what the selection is, and what can be done to it.
 *
 * One file selected, this is the file -- a picture at a glance, the first
 * page of a text, the header of a model -- with its facts and its actions.
 * Several selected, it is the count and the actions that apply to all of
 * them. Nothing selected, it is the folder. There is never a moment it has
 * nothing to say, which is what lets the listing do without checkboxes and
 * per-row menus: everything that used to hang off each row lives here.
 */

/** 1.07e9 is unreadable and 1066247386 is worse. */
function parameters(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  return n.toLocaleString();
}

const label = (text: string) => (
  <Text type="secondary" style={{ fontSize: 10, letterSpacing: 1.2, display: 'block', marginBottom: 2 }}>
    {text}
  </Text>
);

function Fact({ name, copy, children }: { name: string; copy?: () => void; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {label(name)}
        {copy && (
          <Tooltip title="複製">
            <Button size="small" type="text" icon={<CopyOutlined style={{ fontSize: 11 }} />}
                    onClick={copy} style={{ height: 18, width: 18, marginTop: -2 }} />
          </Tooltip>
        )}
      </div>
      <Text style={{ fontSize: 12, fontFamily: MONO, wordBreak: 'break-all' }}>{children}</Text>
    </div>
  );
}

interface Props {
  root: string;
  rootPath: string;
  path: string;
  entries: FsEntry[];
  /** Selected entries, in listing order. */
  chosen: FsEntry[];
  writable: boolean;
  free: number;
  total: number;
  sizes: Record<string, Measured>;
  onMeasure: (name: string) => void;
  onOpen: (entry: FsEntry) => void;
  onView: (entry: FsEntry) => void;
  onRename: (entry: FsEntry) => void;
  onMove: (entries: FsEntry[]) => void;
  onDelete: (entries: FsEntry[]) => void;
  onCopyPath: (entry?: FsEntry) => void;
}

export default function Details({
  root, rootPath, path, entries, chosen, writable, free, total, sizes,
  onMeasure, onOpen, onView, onRename, onMove, onDelete, onCopyPath,
}: Props) {
  const one = chosen.length === 1 ? chosen[0] : null;
  const [peek, setPeek] = useState<FsPeek | null>(null);

  // Text and model headers need a request; pictures do not.
  const wantsPeek = one && one.kind === 'file' && !one.partial
    && (one.media === 'text' || one.media === 'model');
  useEffect(() => {
    if (!one || !wantsPeek) { setPeek(null); return; }
    let live = true;
    setPeek(null);
    fetchFsPeek(root, path, one.name)
      .then((data) => { if (live) setPeek(data); })
      .catch(() => { if (live) setPeek(null); });
    return () => { live = false; };
  }, [root, path, one, wantsPeek]);

  const full = (rel: string) => (rel ? `${rootPath}/${rel}` : rootPath);

  // ---- the folder itself -------------------------------------------------
  if (!chosen.length) {
    const dirs = entries.filter((e) => e.kind === 'dir').length;
    return (
      <Pane title="這個資料夾">
        <Fact name="路徑" copy={() => onCopyPath()}>{full(path)}</Fact>
        <Fact name="內容">{dirs} 個資料夾 ・ {total - dirs} 個檔案</Fact>
        <Fact name="磁碟可用">{bytes(free)}</Fact>
        {!writable && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            這個目錄主控台寫不進去，只能看和下載。
          </Text>
        )}
        <Text type="secondary" style={{ fontSize: 11 }}>
          點一個項目看它的內容；把檔案拖進來就是上傳。
        </Text>
      </Pane>
    );
  }

  // ---- several ------------------------------------------------------------
  if (!one) {
    const known = chosen.reduce((sum, e) => sum + (e.size ?? 0), 0);
    const dirs = chosen.filter((e) => e.kind === 'dir').length;
    return (
      <Pane title={`已選 ${chosen.length} 項`}>
        <Fact name="內容">
          {dirs ? `${dirs} 個資料夾 ・ ` : ''}{chosen.length - dirs} 個檔案
          {known ? ` ・ 檔案合計 ${bytes(known)}` : ''}
        </Fact>
        <Space size={8} wrap>
          <Button size="small" icon={<FolderOpenOutlined />} disabled={!writable}
                  onClick={() => onMove(chosen)}>移動</Button>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={!writable}
                  onClick={() => onDelete(chosen)}>刪除</Button>
        </Space>
      </Pane>
    );
  }

  // ---- one ------------------------------------------------------------------
  const measured = sizes[`${root}:${path}/${one.name}`];
  const isFile = one.kind === 'file' && !one.partial;
  const raw = fsRawUrl(root, path, one.name);

  let body: React.ReactNode = null;
  if (one.kind === 'dir') {
    body = (
      <Fact name="大小">
        {measured === undefined ? (
          <Button size="small" type="link" style={{ padding: 0, height: 'auto', fontSize: 12 }}
                  onClick={() => onMeasure(one.name)}>計算</Button>
        ) : measured === 'working' ? '計算中…'
          : `${bytes(measured.bytes)} ・ ${measured.files.toLocaleString()} 個檔案`}
      </Fact>
    );
  } else if (one.media === 'image') {
    body = (
      <div role="button" tabIndex={0} onClick={() => onView(one)}
           onKeyDown={(e) => { if (e.key === 'Enter') onView(one); }}
           style={{ cursor: 'zoom-in', borderRadius: 4, overflow: 'hidden', border: `1px solid ${LINE.faint}` }}
           title="放大">
        <img src={fsThumbUrl(root, path, one.name)} alt={one.name}
             style={{ display: 'block', width: '100%', maxHeight: 260, objectFit: 'contain', background: '#000' }} />
      </div>
    );
  } else if (one.media === 'video') {
    body = <video src={raw} controls preload="metadata" style={{ width: '100%', maxHeight: 220, background: '#000', borderRadius: 4 }} />;
  } else if (one.media === 'audio') {
    body = <audio src={raw} controls style={{ width: '100%' }} />;
  } else if (peek?.kind === 'text') {
    body = (
      <pre style={{
        margin: 0, padding: 10, fontSize: 11, fontFamily: MONO, lineHeight: 1.5,
        background: '#0b0b0b', border: `1px solid ${LINE.faint}`, borderRadius: 4,
        maxHeight: 240, overflow: 'auto', whiteSpace: 'pre', color: 'rgba(255,255,255,0.75)',
      }}>
        {peek.text.split('\n').slice(0, 40).join('\n')}
        {(peek.truncated || peek.text.split('\n').length > 40) ? '\n…' : ''}
      </pre>
    );
  } else if (peek?.kind === 'model') {
    const meta = (peek.metadata ?? {}) as Record<string, unknown>;
    const thumb = typeof meta['modelspec.thumbnail'] === 'string' ? (meta['modelspec.thumbnail'] as string) : null;
    const arch = meta['general.architecture'] ?? meta['modelspec.architecture'] ?? null;
    const title = meta['general.name'] ?? meta['modelspec.title'] ?? null;
    body = (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {thumb && <img src={thumb} alt="" style={{ width: '100%', borderRadius: 4 }} />}
        <Space size={6} wrap>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>{peek.format}</Tag>
          <Text type="secondary" style={{ fontSize: 11 }}>{peek.count} 個張量</Text>
          {peek.format === 'safetensors' && (
            <Text type="secondary" style={{ fontSize: 11 }}>約 {parameters(peek.parameters)} 參數</Text>
          )}
        </Space>
        {arch != null && <Fact name="架構">{String(arch)}</Fact>}
        {title != null && <Fact name="名稱">{String(title)}</Fact>}
      </Space>
    );
  } else if (one.partial) {
    body = <Tag color="gold">上傳未完成 — 再選同一個檔案上傳就會接著傳</Tag>;
  }

  return (
    <Pane title={one.name} mono>
      {body}
      <Fact name="路徑" copy={() => onCopyPath(one)}>{full(path ? `${path}/${one.name}` : one.name)}</Fact>
      {one.kind === 'file' && one.size !== null && <Fact name="大小">{bytes(one.size)}</Fact>}
      <Fact name="修改時間">{whenLong(one.modified)}</Fact>

      <Space size={8} wrap style={{ marginTop: 4 }}>
        {one.kind === 'dir' && (
          <Button size="small" type="primary" ghost icon={<FolderOpenOutlined />}
                  onClick={() => onOpen(one)}>打開</Button>
        )}
        {isFile && one.media === 'text' && (
          <Button size="small" type="primary" ghost icon={<FormOutlined />}
                  onClick={() => onOpen(one)}>{writable ? '編輯' : '檢視'}</Button>
        )}
        {isFile && (one.media === 'image' || one.media === 'model' || one.media === 'video') && (
          <Button size="small" icon={<ExpandOutlined />} onClick={() => onView(one)}>
            {one.media === 'model' ? '完整標頭' : '放大'}
          </Button>
        )}
        {isFile && (
          <Button size="small" icon={<DownloadOutlined />}
                  href={fsRawUrl(root, path, one.name, true)}>下載</Button>
        )}
        {!one.partial && (
          <Button size="small" icon={<EditOutlined />} disabled={!writable}
                  onClick={() => onRename(one)}>重新命名</Button>
        )}
        <Button size="small" icon={<FolderOpenOutlined />} disabled={!writable || one.partial}
                onClick={() => onMove([one])}>移動</Button>
        <Button size="small" danger icon={<DeleteOutlined />} disabled={!writable}
                onClick={() => onDelete([one])}>刪除</Button>
      </Space>
    </Pane>
  );
}

function Pane({ title, mono, children }: { title: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 14px', minWidth: 0 }}>
      <Text style={{ fontSize: 13, fontFamily: mono ? MONO : undefined, wordBreak: 'break-all' }}>
        {title}
      </Text>
      {children}
    </div>
  );
}
