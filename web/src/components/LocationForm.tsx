import { useEffect, useState } from 'react';
import { Button, Input, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { ArrowUpOutlined, DatabaseOutlined, FolderOutlined, RightOutlined } from '@ant-design/icons';
import { browseFolders, type FolderListing } from '../api';
import { bytes } from './files/kit';
import './files/files.css';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * Where a model location goes, chosen rather than typed.
 *
 * A path is not something most people can type from memory, and a second
 * disk -- the usual reason for a second location -- is somewhere under /mnt
 * or /media they would have to know about. So the form lists the disks, then
 * the folders in the one being looked at, and asks only for the name of the
 * folder to put the models in: `models` makes one folder there, `ai/models`
 * one inside another, and nothing uses the folder being looked at itself.
 *
 * The primary location's path is CONSOLE_MODELS_DIR, set where the service
 * is, so for it the form offers the name alone.
 */

/** `a/b/` → `a/b`, and `..` or an empty segment is refused. */
function cleanName(name: string): { value: string; problem?: string } {
  const value = name.trim().replace(/^\/+|\/+$/g, '');
  if (!value) return { value };
  const parts = value.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    return { value, problem: '名稱裡不能有空的一層或 . 、..' };
  }
  if (/[\s:$\\{}'"`;&|<>*?]/.test(value)) {
    return { value, problem: '名稱不能有空白或 : $ { } 引號等符號' };
  }
  return { value };
}

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

function dirname(p: string) {
  const cut = p.replace(/\/+$/, '').lastIndexOf('/');
  return cut <= 0 ? '/' : p.slice(0, cut);
}

function basename(p: string) {
  return p.replace(/\/+$/, '').split('/').pop() ?? '';
}

export default function LocationForm({
  initialPath = '', initialLabel = '', lockPath, busy, submit, onSubmit, onCancel,
}: {
  initialPath?: string; initialLabel?: string; lockPath?: boolean; busy: boolean;
  submit: string; onSubmit: (path: string, label: string) => void; onCancel: () => void;
}) {
  // Editing opens on the folder the location is in, with its own name filled
  // in, so saving unchanged changes nothing. Adding opens at /.
  const [dir, setDir] = useState(initialPath ? dirname(initialPath) : '');
  const [name, setName] = useState(initialPath ? basename(initialPath) : 'models');
  const [label, setLabel] = useState(initialLabel);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (lockPath) return;
    setLoading(true);
    browseFolders(dir)
      .then((l) => { setListing(l); setError(''); if (!dir) setDir(l.path); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [dir, lockPath]);

  const here = listing?.path ?? dir;
  const cleaned = cleanName(name);
  const target = lockPath ? initialPath : cleaned.value ? join(here, cleaned.value) : here;
  // A name whose first folder is listed already carries that folder's
  // verdict: models under ~/ai is the primary location, not a new folder.
  const first = cleaned.value.split('/')[0];
  const existing = first ? listing?.folders.find((f) => f.name === first) : undefined;
  // What stops a submit, said before it is pressed rather than after.
  const problem = lockPath ? undefined
    : cleaned.problem
      ?? (existing?.blocked ? `${first} ${existing.blocked}` : undefined)
      ?? (!cleaned.value && listing?.blocked ? `這個資料夾${listing.blocked}，不能當位置` : undefined)
      ?? (cleaned.value && listing && !listing.writable ? '主控台沒有這個資料夾的寫入權限，無法在這裡建立資料夾' : undefined);
  const go = () => { if (!problem && target) onSubmit(target, label); };

  const crumbs = here === '/' ? [] : here.split('/').filter(Boolean);
  // The disk being looked at is the deepest mount that holds this folder.
  const onDisk = listing?.disks
    .filter((d) => d.mount === '/' || here === d.mount || here.startsWith(`${d.mount}/`))
    .sort((a, b) => b.mount.length - a.mount.length)[0]?.mount;

  return (
    <div style={{ padding: '10px 0', borderBottom: `1px solid ${LINE.faint}` }}>
      {!lockPath && (
        <>
          {listing && listing.disks.length > 0 && (
            <Space size={6} wrap style={{ marginBottom: 8 }}>
              {listing.disks.map((d) => {
                return (
                  <Tooltip key={d.mount} title={`${d.device}（${d.fstype}）`}>
                    <Tag
                      icon={<DatabaseOutlined />}
                      color={d.mount === onDisk ? 'blue' : undefined}
                      style={{ cursor: 'pointer', marginInlineEnd: 0, padding: '2px 8px' }}
                      onClick={() => setDir(d.mount)}
                    >
                      {d.system ? '系統碟 /' : d.mount}
                      <span style={{ opacity: 0.6, marginInlineStart: 6 }}>
                        剩 {bytes(d.free_bytes)} / {bytes(d.total_bytes)}
                      </span>
                    </Tag>
                  </Tooltip>
                );
              })}
            </Space>
          )}

          <div style={{ border: `1px solid ${LINE.faint}`, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', padding: '6px 10px',
              borderBottom: `1px solid ${LINE.faint}`, fontFamily: MONO, fontSize: 12,
            }}>
              <Button size="small" type="text" style={{ fontFamily: MONO, padding: '0 4px' }}
                      onClick={() => setDir('/')}>/</Button>
              {crumbs.map((c, i) => (
                <Space key={i} size={2}>
                  {i > 0 && <RightOutlined style={{ fontSize: 9, opacity: 0.4 }} />}
                  <Button size="small" type="text" style={{ fontFamily: MONO, padding: '0 4px' }}
                          onClick={() => setDir(`/${crumbs.slice(0, i + 1).join('/')}`)}>
                    {c}
                  </Button>
                </Space>
              ))}
            </div>
            <div style={{ maxHeight: 220, overflowY: 'auto', padding: 4 }}>
              {loading && !listing && <div style={{ padding: 16, textAlign: 'center' }}><Spin size="small" /></div>}
              {error && <Text type="danger" style={{ fontSize: 12, padding: 8, display: 'block' }}>{error}</Text>}
              {listing?.parent && (
                <FolderRow icon={<ArrowUpOutlined />} name="上一層" onOpen={() => setDir(listing.parent)} />
              )}
              {listing?.folders.map((f) => (
                <FolderRow key={f.path} icon={<FolderOutlined />} name={f.name} note={f.blocked}
                           onOpen={() => setDir(f.path)} />
              ))}
              {listing && listing.folders.length === 0 && (
                <Text type="secondary" style={{ fontSize: 12, padding: '6px 10px', display: 'block' }}>
                  這裡沒有其他資料夾
                </Text>
              )}
            </div>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: lockPath ? 0 : 10 }}>
        {!lockPath && (
          <Input
            size="small"
            autoFocus
            addonBefore="資料夾名稱"
            placeholder="留空就用目前這個資料夾"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onPressEnter={go}
            style={{ flex: '2 1 280px', fontFamily: MONO }}
          />
        )}
        <Input
          size="small"
          autoFocus={lockPath}
          addonBefore="顯示名稱"
          placeholder="可不填"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onPressEnter={go}
          style={{ flex: '1 1 200px' }}
        />
        <Space size={6}>
          <Button size="small" onClick={onCancel}>取消</Button>
          <Button size="small" type="primary" loading={busy} disabled={!!problem || !target} onClick={go}>
            {submit}
          </Button>
        </Space>
      </div>

      <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.7 }}>
        <Text type="secondary">將使用 </Text>
        <Text code style={{ fontSize: 12 }}>{target || '—'}</Text>
        {problem
          ? <Text type="danger" style={{ marginInlineStart: 8 }}>{problem}</Text>
          : !lockPath && (
            <Text type="secondary" style={{ marginInlineStart: 8 }}>
              {cleaned.value
                ? cleaned.value.includes('/')
                  ? '名稱裡的 / 會多建一層，不存在的資料夾會自動建立。'
                  : existing ? '用這個已經存在的資料夾。' : '會建立這個資料夾。'
                : '直接用這個資料夾。'}
              {initialPath && target !== initialPath && ' 改路徑前，先把這個位置裡正在使用的模型檔搬過去。'}
            </Text>
          )}
        {lockPath && (
          <Text type="secondary" style={{ marginInlineStart: 8 }}>
            主要位置的路徑由 CONSOLE_MODELS_DIR 決定，這裡只能改顯示名稱。
          </Text>
        )}
      </div>
    </div>
  );
}

function FolderRow({ icon, name, note, onOpen }: {
  icon: React.ReactNode; name: string; note?: string; onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="fs-loc"
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 4,
        cursor: 'pointer', fontSize: 12,
      }}
    >
      <span style={{ opacity: 0.7 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: MONO }}>
        {name}
      </span>
      {note && <Text type="secondary" style={{ fontSize: 11, flex: 'none' }}>{note}</Text>}
    </div>
  );
}
