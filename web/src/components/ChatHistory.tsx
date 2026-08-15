import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Dropdown, Empty, Input, Space, Typography } from 'antd';
import {
  DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, PushpinFilled,
  PushpinOutlined, SearchOutlined,
} from '@ant-design/icons';
import {
  deleteChat, fetchChats, patchChat, type ChatSummary,
} from '../api';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * The conversation list.
 *
 * Grouped by recency rather than shown as one flat list: with a few dozen
 * conversations the useful question is almost always "the one from earlier
 * today", and a date heading answers it faster than reading titles.
 */

interface Props {
  currentId: number | null;
  onOpen: (id: number) => void;
  onNew: () => void;
  /** Bumped by the parent after a save so the list reflects the new title. */
  refreshKey: number;
}

function bucket(updatedAt: number): string {
  const now = Date.now() / 1000;
  const age = now - updatedAt;
  if (age < 86400) return '今天';
  if (age < 172800) return '昨天';
  if (age < 604800) return '本週';
  if (age < 2592000) return '本月';
  return '更早';
}

export default function ChatHistory({ currentId, onOpen, onNew, refreshKey }: Props) {
  const { message, modal } = AntApp.useApp();
  const [items, setItems] = useState<ChatSummary[]>([]);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    fetchChats(query).then(setItems).catch(() => undefined);
  }, [query]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // Debounced so typing a search term does not issue a query per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(load, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  const groups = useMemo(() => {
    const out: { label: string; items: ChatSummary[] }[] = [];
    const pinned = items.filter((i) => i.pinned);
    if (pinned.length) out.push({ label: '已釘選', items: pinned });
    for (const item of items.filter((i) => !i.pinned)) {
      const label = bucket(item.updated_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(item);
      else out.push({ label, items: [item] });
    }
    return out;
  }, [items]);

  const rename = async (id: number) => {
    const title = draft.trim();
    setRenaming(null);
    if (!title) return;
    try {
      await patchChat(id, { title });
      load();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const remove = (item: ChatSummary) => {
    modal.confirm({
      title: '刪除這段對話？',
      content: item.title,
      okText: '刪除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteChat(item.id);
        if (item.id === currentId) onNew();
        load();
      },
    });
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      paddingInline: 6,
    }}>
      <Input
        size="small"
        prefix={<SearchOutlined style={{ opacity: 0.35, fontSize: 11 }} />}
        placeholder="搜尋"
        allowClear
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: 6 }}
      />
      <Button size="small" icon={<PlusOutlined />} onClick={onNew} block
              style={{ marginBottom: 12 }}>
        新對話
      </Button>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {items.length === 0 ? (
          <div style={{ paddingTop: 32 }}>
            <Empty
              description={query ? '沒有符合的對話' : '尚無紀錄'}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} style={{ marginBottom: 12 }}>
              <Text style={{
                fontSize: 10, letterSpacing: 1, opacity: 0.35, fontFamily: MONO,
                display: 'block', marginBottom: 4, paddingInlineStart: 8,
              }}>
                {group.label}
              </Text>
              {group.items.map((item) => {
                const active = item.id === currentId;
                return (
                  <div
                    key={item.id}
                    onClick={() => renaming !== item.id && onOpen(item.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '5px 6px 5px 8px', borderRadius: 4, cursor: 'pointer',
                      background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
                      borderInlineStart: `2px solid ${active ? LINE.strong : 'transparent'}`,
                    }}
                  >
                    {renaming === item.id ? (
                      <Input
                        size="small"
                        value={draft}
                        autoFocus
                        onChange={(e) => setDraft(e.target.value)}
                        onPressEnter={() => rename(item.id)}
                        onBlur={() => rename(item.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={{
                              fontSize: 12.5, display: 'block',
                              overflow: 'hidden', textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              opacity: active ? 1 : 0.8,
                            }}
                          >
                            {item.title || '未命名'}
                          </Text>
                          <Text style={{
                            fontSize: 10, opacity: 0.3, fontFamily: MONO,
                            display: 'block', overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {item.message_count} 則 ・ {item.model || '—'}
                          </Text>
                        </div>
                        {item.pinned ? (
                          <PushpinFilled style={{ fontSize: 10, opacity: 0.5, flexShrink: 0 }} />
                        ) : null}
                        <Dropdown
                          trigger={['click']}
                          menu={{
                            items: [
                              {
                                key: 'pin',
                                icon: item.pinned ? <PushpinOutlined /> : <PushpinFilled />,
                                label: item.pinned ? '取消釘選' : '釘選',
                              },
                              { key: 'rename', icon: <EditOutlined />, label: '重新命名' },
                              { type: 'divider' },
                              { key: 'delete', icon: <DeleteOutlined />, label: '刪除', danger: true },
                            ],
                            onClick: ({ key, domEvent }) => {
                              domEvent.stopPropagation();
                              if (key === 'pin') {
                                void patchChat(item.id, { pinned: !item.pinned }).then(load);
                              } else if (key === 'rename') {
                                setDraft(item.title);
                                setRenaming(item.id);
                              } else if (key === 'delete') {
                                remove(item);
                              }
                            },
                          }}
                        >
                          <Button
                            type="text" size="small" icon={<MoreOutlined />}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              width: 20, minWidth: 20, height: 22,
                              padding: 0, flexShrink: 0, opacity: 0.45,
                            }}
                          />
                        </Dropdown>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      <Space style={{ marginTop: 8 }}>
        <Text style={{ fontSize: 10, opacity: 0.3, fontFamily: MONO }}>
          {items.length} 段對話
        </Text>
      </Space>
    </div>
  );
}
