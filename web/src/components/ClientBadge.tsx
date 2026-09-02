/**
 * Who is talking to this machine, as one number that opens into a list.
 *
 * The console showed load, throughput and slot depth but never who was causing
 * any of it, and the cost of that was not hypothetical: a model was unloaded
 * three times underneath a live opencode session over one night, because
 * nothing on screen said a session was live. The address was in the event
 * stream the whole time and this interface was throwing it away.
 *
 * A badge rather than a card, because the answer is usually "one, me" and a
 * panel that says that in forty square centimetres has earned none of them.
 * It only becomes worth looking at when the count is surprising or something
 * is being refused, and both of those change the badge itself.
 *
 * Refusals are deliberately absent. They belong here -- opencode taking 429s
 * while a slot was wedged, Codex retrying a 500 once a second, both invisible
 * until someone went looking -- but llama-swap's inflight events cannot supply
 * them: a request ends as a bare `remove` with no body, so the stream says a
 * request stopped and never how. That needs the journal or activity.sqlite,
 * which is a separate piece of work rather than a field to read.
 */
import { useMemo } from 'react';
import { Popover, Space, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import type { InflightRequest } from '../api';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/** A client's name from its User-Agent, or its address when it has none.
 *
 *  Only the product token: "opencode/1.18.25 ai-sdk/provider-utils/4.0.23
 *  runtime/bun/1.3" is four libraries introducing themselves, and the first is
 *  the only one that identifies who is at the keyboard. */
function clientOf(r: InflightRequest): string {
  const ua = r.req_headers?.['User-Agent'] ?? r.req_headers?.['user-agent'] ?? '';
  if (!ua) return '';
  const first = ua.split(/\s+/)[0] ?? '';
  const name = first.split('/')[0] ?? '';
  // Browsers all claim to be Mozilla; the word is worth nothing on its own.
  if (name === 'Mozilla') return '瀏覽器';
  return name;
}

/** Long enough to cover a coding agent's think time between calls, short enough
 *  that a machine closed an hour ago has stopped being "connected". */
const RECENT_MS = 10 * 60 * 1000;

interface Party {
  key: string;
  ip: string;
  client: string;
  model: string;
  live: boolean;
  lastSeen: number;
}

export default function ClientBadge({ requests }: { requests: InflightRequest[] }) {
  // Requests still in the list are running: stream.tsx drops each one when
  // llama-swap says `remove`, which it does the moment a request ends. So
  // presence is liveness, and there is nothing here about finished ones.
  const parties = useMemo(() => {
    const cutoff = Date.now() - RECENT_MS;
    const byIp = new Map<string, Party>();

    for (const r of requests) {
      if (r.updated_at < cutoff) continue;
      // Keyed on address *and* client, not address alone. One machine running
      // opencode and Codex at once is two callers competing for the same slots,
      // and collapsing them to one row hides exactly the contention this panel
      // exists to show -- as it did the first time this was tested, where both
      // callers were 127.0.0.1 and only one appeared.
      const client = clientOf(r);
      const key = `${r.remote_ip}|${client}`;
      const party: Party = byIp.get(key) ?? {
        key, ip: r.remote_ip, client: '', model: '', live: false, lastSeen: 0,
      };
      if (r.updated_at >= party.lastSeen) {
        party.lastSeen = r.updated_at;
        party.client = client || party.client;
        party.model = r.model || party.model;
      }
      party.live = true;
      byIp.set(key, party);
    }

    return [...byIp.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }, [requests]);

  if (parties.length === 0) return null;

  const liveCount = parties.filter((p) => p.live).length;

  const detail = (
    <div style={{ minWidth: 300 }}>
      {parties.map((p) => (
        <div
          key={p.key}
          style={{
            display: 'flex', alignItems: 'baseline', gap: 10,
            fontFamily: MONO, fontSize: 11, padding: '3px 0',
          }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto',
            background: p.live ? ACCENT.ok : LINE.strong,
            boxShadow: p.live ? `0 0 6px ${ACCENT.ok}b3` : 'none',
          }} />
          <span style={{ minWidth: 76 }}>{p.client || '—'}</span>
          <span style={{ opacity: 0.5, minWidth: 108 }}>{p.ip}</span>
          <span style={{ opacity: 0.4, marginInlineStart: 'auto' }}>
            {p.model.replace(/^qwen38-27b-/, '') || '—'}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <Popover content={detail} placement="bottomRight" trigger={['hover', 'click']}>
      <Space size={6} style={{ cursor: 'default' }}>
        <UserOutlined style={{ fontSize: 11, opacity: 0.5 }} />
        <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.7 }}>
          {liveCount} 個進行中
        </Text>
      </Space>
    </Popover>
  );
}
