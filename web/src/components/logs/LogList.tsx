import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Empty, Typography } from 'antd';
import { CopyOutlined, DownOutlined } from '@ant-design/icons';
import type { JournalLine } from '../../api';
import { ACCENT, MONO } from '../../theme';
import './logs.css';

const { Text } = Typography;

/**
 * The lines themselves.
 *
 * A grid rather than a flow: every row shares the same columns, so the
 * message starts at the same x on every line and the eye has a straight
 * edge to run down. Severity lives in a gutter and, for errors, in a wash
 * behind the row -- not in the colour of the message, since a whole line
 * of red is the hardest thing on the page to read.
 *
 * Following: the pane sticks to the bottom while it is at the bottom.
 * Scrolling up releases it and new lines collect behind a pill that says
 * how many; pressing it, or scrolling back down, catches up. Nothing is
 * ever yanked out from under a reader.
 */

export const LEVEL_SHORT: Record<string, string> = { error: 'ERR', warn: 'WARN', info: 'INFO' };
export const LEVEL_COLOUR: Record<string, string> = {
  error: ACCENT.error, warn: ACCENT.warn, info: 'rgba(255,255,255,0.35)',
};

/** A fixed hue per source, kept clear of the status colours. */
export function sourceColour(unit: string): string {
  const palette = ['#6ea8fe', '#6fd0c4', '#c79bf0', '#9ccc8a', '#f0a6c0', '#e8c46f'];
  let h = 0;
  for (const ch of unit) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString('zh-TW', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function day(t: number): string {
  return new Date(t * 1000).toLocaleDateString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  });
}

const dayKey = (t: number) => new Date(t * 1000).toDateString();

interface Props {
  lines: JournalLine[];
  /** Whether new lines should pull the view down. */
  follow: boolean;
  onFollow: (on: boolean) => void;
  wrap: boolean;
  /** Something to say where the lines would be: why there are none. */
  empty: string;
  /** The oldest line the read reached, when the window was cut short. */
  notice?: string;
}

export default function LogList({ lines, follow, onFollow, wrap, empty, notice }: Props) {
  const { message } = AntApp.useApp();
  const pane = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [behind, setBehind] = useState(0);
  const lastCount = useRef(0);

  const atBottom = () => {
    const el = pane.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  // New lines: scroll if following, else count them for the pill.
  useEffect(() => {
    const grew = lines.length - lastCount.current;
    lastCount.current = lines.length;
    const el = pane.current;
    if (!el) return;
    if (follow) {
      el.scrollTop = el.scrollHeight;
      setBehind(0);
    } else if (grew > 0) {
      setBehind((n) => n + grew);
    }
  }, [lines, follow]);

  // A fresh window (the count reset or the first lines) starts at the bottom.
  useEffect(() => {
    if (lines.length && lines.length < lastCount.current) lastCount.current = lines.length;
  }, [lines.length]);

  const onScroll = useCallback(() => {
    const bottom = atBottom();
    if (bottom && !follow) { onFollow(true); setBehind(0); }
    if (!bottom && follow) onFollow(false);
  }, [follow, onFollow]);

  // A line that was JSON is copied as that JSON, exactly as the program
  // wrote it -- types and all, which the flattened fields lost. A plain line
  // is copied as shown.
  const copy = async (line: JournalLine) => {
    const text = line.raw
      ?? `${clock(line.t)} ${line.label} ${LEVEL_SHORT[line.level] ?? line.level} ${line.text}`;
    try {
      await navigator.clipboard.writeText(text);
      message.success({ content: line.raw ? '已複製原始 JSON' : '已複製這一行', duration: 1.5 });
    } catch {
      message.error('複製不了，瀏覽器不給剪貼簿');
    }
  };

  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={pane} className={`lg-pane${wrap ? ' lg-wrap' : ''}`} onScroll={onScroll}>
        {!lines.length ? (
          <div style={{ height: '100%', display: 'grid', placeItems: 'center' }}>
            <Empty description={empty} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        ) : lines.map((line, i) => {
          const key = `${line.t}:${line.unit}:${i}`;
          const expandable = !!line.fields?.length;
          const opened = open.has(key);
          const newDay = i === 0 || dayKey(lines[i - 1].t) !== dayKey(line.t);
          return (
            <Fragment key={key}>
              {newDay && (
                <div className="lg-day">
                  <span>{day(line.t)}</span>
                </div>
              )}
              <div
                className={`lg-row lg-${line.level}${expandable ? ' lg-expandable' : ''}${line.noise ? ' lg-noise' : ''}`}
                onClick={expandable ? () => toggle(key) : undefined}
              >
                <span className="lg-time">{clock(line.t)}</span>
                <span className="lg-level" style={{ color: LEVEL_COLOUR[line.level] }}>
                  {LEVEL_SHORT[line.level] ?? line.level}
                </span>
                <span className="lg-unit" style={{ color: sourceColour(line.unit) }} title={line.unit}>
                  {line.label}
                </span>
                <span className="lg-text">
                  {expandable && (
                    <DownOutlined className="lg-caret" style={{ transform: opened ? 'none' : 'rotate(-90deg)' }} />
                  )}
                  {line.text}
                </span>
                <Button size="small" type="text" className="lg-copy" icon={<CopyOutlined />}
                        onClick={(e) => { e.stopPropagation(); void copy(line); }} />
              </div>
              {opened && line.fields && (
                <div className="lg-fields">
                  {line.fields.map(([k, v]) => (
                    <Fragment key={k}>
                      <span className="lg-key">{k}</span>
                      <span className="lg-val">{v}</span>
                    </Fragment>
                  ))}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>

      {notice && (
        <div className="lg-notice">
          <Text type="secondary" style={{ fontSize: 11 }}>{notice}</Text>
        </div>
      )}

      {!follow && behind > 0 && (
        <Button
          size="small"
          className="lg-behind"
          icon={<DownOutlined />}
          onClick={() => {
            const el = pane.current;
            if (el) el.scrollTop = el.scrollHeight;
            onFollow(true);
            setBehind(0);
          }}
          style={{ fontFamily: MONO }}
        >
          {behind} 新行
        </Button>
      )}
    </div>
  );
}
