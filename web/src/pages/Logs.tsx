import { useEffect, useState } from 'react';
import { Card, Space, Tag, Typography } from 'antd';
import JournalView from '../components/JournalView';
import { useStream } from '../stream';
import { fetchLogs, subscribe, type JournalLine } from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

/** Kept in step with the backend's own buffer, so scrolling back reaches the
 *  same distance the server remembers and no further. */
const MAX_LINES = 4000;

/**
 * The log page.
 *
 * History is fetched once and then extended from the stream, rather than built
 * from whatever arrives after the page opens. Almost every reason to open this
 * page is something that already happened.
 */
export default function Logs() {
  const { requests } = useStream();
  const [lines, setLines] = useState<JournalLine[]>([]);

  useEffect(() => {
    fetchLogs(MAX_LINES).then((data) => setLines(data.lines)).catch(() => undefined);
  }, []);

  useEffect(() => subscribe((event) => {
    if (event.type !== 'journal') return;
    setLines((prev) => {
      const next = [...prev, event.data as JournalLine];
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }), []);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* In-flight requests are not log lines and do not belong in the stream:
          llama-swap reports them as state, and it never retracts one, so they
          are shown separately and aged out rather than appended. */}
      {requests.length > 0 && (
        <Card size="small" title={
          <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 0.8 }}>IN FLIGHT</span>
        }>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {requests.map((r) => (
              <Space key={r.id} size={8}>
                <Tag style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>
                  {r.model ?? '—'}
                </Tag>
                <Text style={{ fontSize: 12, opacity: 0.7 }}>
                  {r.method} {r.req_path}
                </Text>
                <Text style={{ fontSize: 11, opacity: 0.35, fontFamily: MONO }}>
                  {(r.elapsed_ms / 1000).toFixed(1)}s
                </Text>
              </Space>
            ))}
          </Space>
        </Card>
      )}

      <JournalView
        lines={lines}
        // Fills what is left under the header and page padding, so the pane
        // grows with the window instead of leaving the rest of the screen empty.
        height="calc(100vh - 56px - 48px - 150px)"
      />
    </Space>
  );
}
