import { useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp, Button, Card, DatePicker, Dropdown, Empty, Input, Segmented, Select,
  Space, Tag, Tooltip, Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import {
  CopyOutlined, DownloadOutlined, PauseOutlined, PlayCircleOutlined,
  RightOutlined, SearchOutlined,
} from '@ant-design/icons';
import { ACCENT, LINE, MONO, SOURCE_COLOURS } from '../theme';
import type { JournalLine } from '../api';
import './journal.css';

const { Text } = Typography;

/**
 * The log viewer.
 *
 * Lines arrive already classified by the backend, which reads them from the
 * journal: the unit that emitted each one and its severity are facts rather
 * than guesses at the text.
 *
 * Laid out as a fixed grid rather than a flow. Reading a log is scanning, and
 * scanning needs a straight edge to run down -- a per-row chip and a flex gap
 * put the message at a different x on every line, which is what made the first
 * version of this tiring to read.
 *
 * Four filters, which is what it takes to find one line among thousands: which
 * service, how bad, how recent, and how far back to look at all. They compose,
 * and the count beside each level is of what survives the others.
 */

const LEVELS = ['error', 'warn', 'info'] as const;
const LEVEL_LABEL: Record<string, string> = { error: '錯誤', warn: '警告', info: '一般' };
/** On the rows themselves, where the column is narrow and every line carries
 *  one. Latin and monospace keeps it to four characters and lines the badges
 *  up with each other, the way the tile labels elsewhere do. */
const LEVEL_SHORT: Record<string, string> = { error: 'ERR', warn: 'WARN', info: 'INFO' };
const LEVEL_COLOUR: Record<string, string> = {
  error: ACCENT.error,
  warn: ACCENT.warn,
  info: '#7fb0e8',
};

/** -1 is the custom range; the picker beside it supplies the bounds. */
const CUSTOM = -1;

const RANGES = [
  { label: '全部時間', value: 0 },
  { label: '最近 1 小時', value: 3600 },
  { label: '最近 6 小時', value: 21600 },
  { label: '最近 24 小時', value: 86400 },
  { label: '最近 7 天', value: 604800 },
  { label: '自訂區間', value: CUSTOM },
];

/** Capped at the backend's own buffer: offering more would promise history the
 *  server does not keep. */
const TAILS = [
  { label: '最近 100 行', value: 100 },
  { label: '最近 300 行', value: 300 },
  { label: '最近 1000 行', value: 1000 },
  { label: '全部保留', value: 0 },
];

/**
 * The matched substring, marked in place.
 *
 * Filtering already removes the lines that do not match, but on a line eighty
 * characters wide the reason it survived is not obvious. Built as elements
 * rather than by injecting HTML: log text is untrusted, and a line containing
 * a tag would otherwise be parsed as one.
 */
function highlight(text: string, term: string) {
  if (!term) return text;
  const needle = term.toLowerCase();
  const hay = text.toLowerCase();
  const out: React.ReactNode[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) out.push(text.slice(from, at));
    out.push(<mark key={at} className="jv-mark">{text.slice(at, at + term.length)}</mark>);
    from = at + term.length;
  }
  if (!out.length) return text;
  if (from < text.length) out.push(text.slice(from));
  return out;
}

function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString('zh-TW', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/** The whole instant, for the hover title. The column shows only the time, and
 *  the buffer can reach back past midnight. */
function fullStamp(t: number): string {
  return new Date(t * 1000).toLocaleString('zh-TW', { hour12: false });
}

/** One line as text, with its structure below it when there is any. */
function asText(line: JournalLine): string {
  const head = `${fullStamp(line.t)}  [${line.label}/${line.level}]  ${line.text}`;
  if (!line.fields?.length) return head;
  return [head, ...line.fields.map(([k, v]) => `    ${k} = ${v}`)].join('\n');
}

/**
 * Export formats, each for a different destination.
 *
 * Plain text is what a terminal and a chat window want. JSON keeps the parsed
 * structure so the file can be queried rather than read. Markdown is for
 * pasting into an issue or a document -- a list rather than a table, because a
 * log message is long and a table column is not.
 */
const FORMATS = {
  txt: {
    label: '純文字 (.txt)',
    extension: 'txt',
    mime: 'text/plain',
    render: (lines: JournalLine[]) => lines.map(asText).join('\n'),
  },
  json: {
    label: 'JSON (.json)',
    extension: 'json',
    mime: 'application/json',
    render: (lines: JournalLine[]) => JSON.stringify(
      lines.map((l) => ({
        time: new Date(l.t * 1000).toISOString(),
        source: l.label,
        unit: l.unit,
        level: l.level,
        message: l.text,
        ...(l.fields?.length ? { fields: Object.fromEntries(l.fields) } : {}),
      })),
      null,
      2,
    ),
  },
  md: {
    label: 'Markdown (.md)',
    extension: 'md',
    mime: 'text/markdown',
    render: (lines: JournalLine[]) => {
      const body = lines.map((l) => {
        const head = `- \`${fullStamp(l.t)}\` **${l.label}** \`${l.level.toUpperCase()}\``
          + ` — ${l.text.replace(/\n/g, ' ')}`;
        if (!l.fields?.length) return head;
        return [head, ...l.fields.map(([k, v]) => `  - \`${k}\` = ${v}`)].join('\n');
      }).join('\n');
      return `# 日誌匯出\n\n共 ${lines.length} 行，匯出於 ${fullStamp(Date.now() / 1000)}。\n\n${body}\n`;
    },
  },
} as const;

type Format = keyof typeof FORMATS;

interface Props {
  lines: JournalLine[];
  height: number | string;
}

export default function JournalView({ lines, height }: Props) {
  const { message } = AntApp.useApp();
  const [unit, setUnit] = useState('all');
  /** Which instance within the selected source, when a source has more than
   *  one. ComfyUI is the case that needs it: one container per card, both
   *  called 圖像, and the one you want is the one that just failed. */
  const [instance, setInstance] = useState('all');
  const [levels, setLevels] = useState<Set<string>>(() => new Set(LEVELS));
  const [range, setRange] = useState(0);
  /** Bounds for the custom range, as epoch seconds. Null until both are set,
   *  so choosing 「自訂區間」 does not blank the pane before a date is picked. */
  const [custom, setCustom] = useState<[number, number] | null>(null);
  const [tail, setTail] = useState(1000);
  const [format, setFormat] = useState<Format>('txt');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  /**
   * The snapshot shown while paused.
   *
   * Holding the rendered list still is the whole point of pausing: merely
   * stopping the scroll leaves new lines pushing in underneath, so the line
   * being read moves anyway. Lines keep arriving into `lines`; what is waiting
   * is the difference.
   */
  const [frozen, setFrozen] = useState<JournalLine[] | null>(null);
  /**
   * Separate from `frozen`, and both are needed.
   *
   * Pausing is a decision; scrolling up is just reading. Someone who scrolls
   * back to look at something should not have the view dragged out from under
   * them by the next line, but they also have not asked for the stream to stop
   * -- returning to the bottom resumes on its own.
   */
  const [atBottom, setAtBottom] = useState(true);
  const pane = useRef<HTMLDivElement>(null);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已複製${what}`);
    } catch {
      // Clipboard access needs a secure context; over plain HTTP it is blocked.
      message.warning('瀏覽器不允許複製，請手動選取');
    }
  };

  const source = frozen ?? lines;
  const waiting = frozen ? lines.length - frozen.length : 0;

  /** Applied in order: how far back, then how many. Trimming by count first
   *  would make the time window search a list that had already been cut. */
  const windowed = useMemo(() => {
    let out = source;
    if (range === CUSTOM) {
      // Only once both ends exist. A half-set range would otherwise read as
      // "no results" rather than as "still choosing".
      if (custom) {
        out = out.filter((line) => line.t >= custom[0] && line.t <= custom[1]);
      }
    } else if (range) {
      const cutoff = Date.now() / 1000 - range;
      out = out.filter((line) => line.t >= cutoff);
    }
    if (tail && out.length > tail) out = out.slice(-tail);
    return out;
  }, [source, range, custom, tail]);

  const units = useMemo(() => {
    const seen = new Map<string, number>();
    for (const line of windowed) seen.set(line.label, (seen.get(line.label) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  }, [windowed]);

  /** The units behind the selected source. Empty for a source that is a single
   *  unit, which is every one of them except ComfyUI, so the second row of
   *  buttons appears only where there is a choice to make. */
  const instances = useMemo(() => {
    if (unit === 'all') return [];
    const seen = new Set<string>();
    for (const line of windowed) if (line.label === unit) seen.add(line.unit);
    return [...seen].sort();
  }, [windowed, unit]);

  /** Their shared prefix, dropped from the buttons: `comfyui-xpu` and
   *  `comfyui-nv0` are told apart by what differs, and the part they share is
   *  already said by the source button beside them. */
  const trim = useMemo(() => {
    if (instances.length < 2) return 0;
    const [first] = instances;
    let at = 0;
    while (at < first.length && instances.every((name) => name[at] === first[at])) at += 1;
    const cut = first.slice(0, at).lastIndexOf('-');
    return cut < 0 ? 0 : cut + 1;
  }, [instances]);

  /** A source with one unit has nothing to choose, and a stale choice from the
   *  previously selected source would hide every line. */
  useEffect(() => { setInstance('all'); }, [unit]);

  /** Per level, within everything else that is selected -- so the number beside
   *  「錯誤」 answers "how many errors am I currently not seeing". */
  const levelCounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const counts: Record<string, number> = { error: 0, warn: 0, info: 0 };
    for (const line of windowed) {
      if (unit !== 'all' && line.label !== unit) continue;
      if (instance !== 'all' && line.unit !== instance) continue;
      if (needle && !line.text.toLowerCase().includes(needle)) continue;
      counts[line.level] = (counts[line.level] ?? 0) + 1;
    }
    return counts;
  }, [windowed, unit, instance, query]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return windowed.filter((line) => {
      if (unit !== 'all' && line.label !== unit) return false;
      if (instance !== 'all' && line.unit !== instance) return false;
      if (!levels.has(line.level)) return false;
      if (needle && !line.text.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [windowed, unit, instance, levels, query]);

  useEffect(() => {
    if (!frozen && atBottom && pane.current) {
      pane.current.scrollTop = pane.current.scrollHeight;
    }
  }, [shown, frozen, atBottom]);

  const toggleLevel = (level: string) => setLevels((prev) => {
    const next = new Set(prev);
    if (next.has(level)) next.delete(level); else next.add(level);
    // Never leave nothing selected: an empty pane with no explanation reads as
    // a broken viewer rather than as a filter.
    return next.size ? next : new Set(LEVELS);
  });

  const download = (as: Format) => {
    const spec = FORMATS[as];
    const blob = new Blob([spec.render(shown)], { type: `${spec.mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `logs-${new Date().toISOString().slice(0, 19)
      .replace(/[:T-]/g, '')}.${spec.extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setFormat(as);
  };

  return (
    <Card
      size="small"
      title={
        <Space size={10}>
          <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 0.8 }}>LOGS</span>
          <Text style={{ fontSize: 11, opacity: 0.35, fontFamily: MONO }}>
            {shown.length === lines.length ? `${lines.length}` : `${shown.length} / ${lines.length}`}
          </Text>
          {waiting > 0 && (
            <Tag
              style={{ fontSize: 10, fontFamily: MONO, marginInlineEnd: 0, cursor: 'pointer' }}
              onClick={() => { setFrozen(null); setAtBottom(true); }}
            >
              +{waiting} 待顯示
            </Tag>
          )}
        </Space>
      }
      extra={
        <Space size={6}>
          <Input
            size="small"
            prefix={<SearchOutlined style={{ opacity: 0.35, fontSize: 11 }} />}
            placeholder="搜尋"
            allowClear
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 160 }}
          />
          <Tooltip title="複製目前顯示的行">
            <Button size="small" icon={<CopyOutlined />} disabled={!shown.length}
                    onClick={() => copy(shown.map(asText).join('\n'), `${shown.length} 行`)} />
          </Tooltip>
          <Dropdown
            disabled={!shown.length}
            menu={{
              items: (Object.keys(FORMATS) as Format[]).map((key) => ({
                key,
                label: FORMATS[key].label,
              })),
              onClick: ({ key }) => download(key as Format),
            }}
          >
            {/* The last format used is the one the button repeats, so the
                common case is one click and the menu is for changing it. */}
            <Button size="small" icon={<DownloadOutlined />}
                    onClick={() => download(format)} />
          </Dropdown>
          <Button
            size="small"
            icon={frozen ? <PlayCircleOutlined /> : <PauseOutlined />}
            onClick={() => {
              if (frozen) {
                setFrozen(null);
                setAtBottom(true);
              } else {
                setFrozen(lines);
              }
            }}
          >
            {frozen ? '已暫停' : '跟隨中'}
          </Button>
        </Space>
      }
    >
      <Space size={10} wrap style={{ marginBottom: 10 }}>
        <Segmented
          size="small"
          value={unit}
          onChange={(v) => setUnit(String(v))}
          options={[{ label: '全部', value: 'all' },
            ...units.map((label) => ({ label, value: label }))]}
        />

        {instances.length > 1 && (
          <Segmented
            size="small"
            value={instance}
            onChange={(v) => setInstance(String(v))}
            options={[{ label: '全部', value: 'all' },
              ...instances.map((name) => ({ label: name.slice(trim), value: name }))]}
          />
        )}

        {/* Levels are independent switches rather than one choice: "errors and
            warnings but not information" is the normal way to read a log, and a
            single-select cannot express it. */}
        <Space size={4}>
          {LEVELS.map((level) => {
            const on = levels.has(level);
            return (
              <button
                key={level}
                type="button"
                className={`jv-level${on ? ' jv-level-on' : ''}`}
                onClick={() => toggleLevel(level)}
              >
                <span className="jv-dot" style={{ background: LEVEL_COLOUR[level] }} />
                {LEVEL_LABEL[level]}
                <span className="jv-level-count">{levelCounts[level] ?? 0}</span>
              </button>
            );
          })}
        </Space>

        <Select size="small" value={range} onChange={setRange}
                options={RANGES} style={{ width: 122 }} />
        {range === CUSTOM && (
          <DatePicker.RangePicker
            size="small"
            showTime={{ format: 'HH:mm' }}
            format="MM/DD HH:mm"
            placeholder={['開始', '結束']}
            onChange={(values) => {
              const pair = values as [Dayjs | null, Dayjs | null] | null;
              if (!pair?.[0] || !pair[1]) { setCustom(null); return; }
              setCustom([pair[0].valueOf() / 1000, pair[1].valueOf() / 1000]);
            }}
            style={{ width: 250 }}
          />
        )}
        <Select size="small" value={tail} onChange={setTail}
                options={TAILS} style={{ width: 122 }} />
      </Space>

      <div
        ref={pane}
        className="jv-pane"
        onScroll={() => {
          const el = pane.current;
          if (!el) return;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (bottom !== atBottom) setAtBottom(bottom);
        }}
        style={{ height, border: `1px solid ${LINE.faint}` }}
      >
        {shown.length === 0 ? (
          <div style={{ paddingTop: '12vh' }}>
            <Empty
              description={lines.length ? '沒有符合的行' : '尚無日誌'}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        ) : (
          shown.map((line, index) => {
            const id = `${line.t}-${line.text.slice(0, 40)}`;
            const expandable = !!line.fields?.length;
            const expanded = open.has(id);
            return (
              <div key={`${line.t}-${index}`}>
                <div
                  className={`jv-row jv-${line.level}${expandable ? ' jv-expandable' : ''}`}
                  onClick={expandable ? () => setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id); else next.add(id);
                    return next;
                  }) : undefined}
                >
                  <span className="jv-time" title={fullStamp(line.t)}>{clock(line.t)}</span>
                  {/* Fixed width and centred, so a level name of a different
                      length cannot move the message column. */}
                  <span className={`jv-badge jv-badge-${line.level}`}>
                    {LEVEL_SHORT[line.level]}
                  </span>
                  <span
                    className="jv-unit"
                    style={{ color: SOURCE_COLOURS[line.label] ?? undefined }}
                  >
                    {/* Shown on every row, not only when it changes. Dropping
                        the repeats read as tidier but left most rows with an
                        empty column, which is most of why the pane looked
                        monochrome -- the colour was there and simply absent. */}
                    {line.label}
                  </span>
                  <span className="jv-text">
                    {expandable && (
                      <RightOutlined
                        className={`jv-chevron${expanded ? ' jv-chevron-open' : ''}`}
                      />
                    )}
                    {highlight(line.text, query.trim())}
                    {expandable && !expanded && (
                      <span className="jv-hint">+{line.fields!.length}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="jv-copy"
                    title="複製這一行"
                    onClick={(e) => { e.stopPropagation(); void copy(asText(line), '這一行'); }}
                  >
                    <CopyOutlined />
                  </button>
                </div>
                {expandable && expanded && (
                  <div className="jv-fields">
                    {line.fields!.map(([key, value]) => (
                      <div className="jv-field" key={key}>
                        <span className="jv-key">{key}</span>
                        <span className="jv-value">{value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
