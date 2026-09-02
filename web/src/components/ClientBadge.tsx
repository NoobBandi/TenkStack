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
import { Fragment, useEffect, useMemo, useState } from 'react';
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
  /** When the running request began, in browser time: llama-swap's elapsed_ms
   *  plus how long ago that reading arrived. Its counter only moves when it
   *  sends an update, so showing it raw freezes at whatever it last said --
   *  which for a request that has been going two minutes was often 0s. */
  startedAt: number;
}

/** A duration as something to read at a glance, not a number to parse. */
function since(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export default function ClientBadge({ requests }: { requests: InflightRequest[] }) {
  // Ticks the durations. llama-swap sends an update per request, not per
  // second, so without this the times sit still while the requests run.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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
        key, ip: r.remote_ip, client: '', model: '', live: false,
        lastSeen: 0, startedAt: 0,
      };
      if (r.updated_at >= party.lastSeen) {
        party.lastSeen = r.updated_at;
        party.client = client || party.client;
        party.model = r.model || party.model;
        party.startedAt = r.updated_at - (r.elapsed_ms ?? 0);
      }
      party.live = true;
      byIp.set(key, party);
    }

    return [...byIp.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }, [requests]);

  if (parties.length === 0) return null;

  const liveCount = parties.filter((p) => p.live).length;
  // Deduplicated: two clients on one model is one name, not two.
  const models = [...new Set(parties.map((p) => p.model).filter(Boolean))];

  const detail = (
    <div style={{ minWidth: 260, maxWidth: 420 }}>
      {/* A grid, not flex with minWidths. Flex sizes each cell to its own
          content and then fights the minimum, so a long client name pushed the
          address out of line with the row above it -- columns that do not line
          up are the whole reason a table beats a sentence. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(72px, max-content) 1fr auto',
        columnGap: 14, rowGap: 0, alignItems: 'center',
      }}>
        <span />
        {['客戶端', '位址', '時間'].map((h, i) => (
          <Text
            key={h}
            style={{
              fontSize: 9, letterSpacing: 1, opacity: 0.35,
              textAlign: i === 2 ? 'right' : 'left',
              paddingBottom: 5,
            }}
          >
            {h}
          </Text>
        ))}

        {parties.map((p) => (
          <Fragment key={p.key}>
            {/* Centred on the row, not on the text baseline: a dot has no
                baseline of its own and sat low against every name. */}
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: p.live ? ACCENT.ok : LINE.strong,
              boxShadow: p.live ? `0 0 7px ${ACCENT.ok}b3` : 'none',
            }} />
            <Text style={{ fontSize: 11, fontFamily: MONO, lineHeight: '22px' }}>
              {p.client || '—'}
            </Text>
            <Text style={{
              fontSize: 11, fontFamily: MONO, opacity: 0.45, lineHeight: '22px',
            }}>
              {p.ip}
            </Text>
            <Text style={{
              fontSize: 11, fontFamily: MONO, opacity: 0.55,
              lineHeight: '22px', textAlign: 'right',
            }}>
              {since(now - p.startedAt)}
            </Text>
          </Fragment>
        ))}
      </div>

      {/* The model on its own line under the table rather than a fifth column.
          It is nearly always the same for every row -- one model is loaded at a
          time -- and a column repeating one value four times is four times the
          width for none of the information. */}
      {models.length > 0 && (
        <div style={{
          marginTop: 8, paddingTop: 7, borderTop: `1px solid ${LINE.faint}`,
          display: 'flex', gap: 8, alignItems: 'baseline',
        }}>
          <Text style={{ fontSize: 9, letterSpacing: 1, opacity: 0.35 }}>模型</Text>
          <Text style={{ fontSize: 10, fontFamily: MONO, opacity: 0.55 }}>
            {models.join(' ・ ')}
          </Text>
        </div>
      )}
    </div>
  );

  return (
    <Popover
      content={detail}
      // bottomLeft, not bottomRight: antd names these by which edge aligns with
      // the trigger, not by which way the panel grows. The badge sits at the
      // left of a card title, so aligning its right edge sent the whole popover
      // leftwards over the sidebar and the chart beside it.
      placement="bottomLeft"
      trigger={['hover', 'click']}
      // antd's default inner padding is sized for a sentence of prose. This is
      // a dense table, and the stock 12px around it read as a small table
      // floating in a large box.
      styles={{ content: { padding: '10px 12px' } }}
      // Hover on a badge is easy to leave by accident on the way to reading it.
      mouseEnterDelay={0.15}
      mouseLeaveDelay={0.25}
    >
      <Space size={6} style={{ cursor: 'default' }}>
        <UserOutlined style={{ fontSize: 11, opacity: 0.5 }} />
        <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.7 }}>
          {liveCount} 個進行中
        </Text>
      </Space>
    </Popover>
  );
}
