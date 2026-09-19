import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, DatePicker, Input, Segmented, Tooltip, Typography,
} from 'antd';
import type { InputRef } from 'antd';
import {
  DownloadOutlined, PauseOutlined, PlayCircleOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  fetchLogSources, queryLogs, subscribe,
  type JournalLine, type LogSources, type LogsQuery,
} from '../api';
import { useStream } from '../stream';
import LogList, { LEVEL_COLOUR, sourceColour } from '../components/logs/LogList';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * The log page.
 *
 * What is on screen comes from the journal and docker's own files, over a
 * window that is real: an hour is an hour of history, whatever the console
 * has been doing, and a reload shows the same hour. The buffer the
 * followers fill only extends that window forward while the page is open.
 *
 * Laid out like the file manager: the sources down the left, each with
 * whether it is being read and how many lines it put in this window --
 * which is what answers "is this being recorded at all" -- the window and
 * the filters across the top, and the lines in the middle.
 */

const WINDOWS = [
  { label: '15 分', value: 900 },
  { label: '1 時', value: 3600 },
  { label: '6 時', value: 21600 },
  { label: '24 時', value: 86400 },
  { label: '7 天', value: 604800 },
  { label: '自訂', value: -1 },
];

const LEVELS = ['error', 'warn', 'info'] as const;
const LEVEL_LABEL: Record<string, string> = { error: '錯誤', warn: '警告', info: '一般' };
const LIMIT = 5000;
const SIDEBAR_W = 196;

const stamp = (t: number) => dayjs(t * 1000).format('MM/DD HH:mm');

export default function Logs() {
  const { requests } = useStream();
  const [sources, setSources] = useState<LogSources | null>(null);
  const [windowSec, setWindowSec] = useState(3600);
  const [custom, setCustom] = useState<[number, number] | null>(null);
  const [units, setUnits] = useState<Set<string>>(() => new Set());
  const [levels, setLevels] = useState<Set<string>>(() => new Set(LEVELS));
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [noise, setNoise] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(true);
  const [result, setResult] = useState<LogsQuery | null>(null);
  const [lines, setLines] = useState<JournalLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);
  const search = useRef<InputRef>(null);
  // What the live feed is measured against, held in a ref so the
  // subscription need not be rebuilt on every keystroke.
  const filter = useRef({ units, levels, q, noise, live: windowSec > 0 });
  filter.current = { units, levels, q, noise, live: windowSec > 0 };

  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const loadSources = useCallback(() => {
    fetchLogSources().then(setSources).catch(() => undefined);
  }, []);
  useEffect(() => {
    loadSources();
    const timer = setInterval(loadSources, 30000);
    return () => clearInterval(timer);
  }, [loadSources]);

  const run = useCallback(async () => {
    const now = Date.now() / 1000;
    const [since, until] = windowSec > 0
      ? [now - windowSec, now]
      : custom ?? [now - 3600, now];
    setLoading(true);
    try {
      const found = await queryLogs({
        since, until, units: [...units], q, noise, limit: LIMIT,
        levels: levels.size === LEVELS.length ? [] : [...levels],
      });
      setResult(found);
      setLines(found.lines);
      setLoadedAt(now);
      setFollow(windowSec > 0);
    } catch {
      setResult(null);
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [windowSec, custom, units, levels, q, noise]);

  useEffect(() => { void run(); }, [run]);

  // The live feed only extends a relative window; a custom range is a
  // question about the past and does not grow.
  useEffect(() => subscribe((event) => {
    if (event.type !== 'journal') return;
    const line = event.data as JournalLine;
    const f = filter.current;
    if (!f.live) return;
    if (line.noise && !f.noise) return;
    if (f.q && !line.text.toLowerCase().includes(f.q.toLowerCase())) return;
    // The same facet rule as the query: a source's count leaves the source
    // filter out, a level's count leaves the level filter out.
    const unitOK = !f.units.size || f.units.has(line.unit);
    const levelOK = f.levels.has(line.level);
    setResult((prev) => (prev ? {
      ...prev,
      total: prev.total + (unitOK && levelOK ? 1 : 0),
      by_level: unitOK ? { ...prev.by_level, [line.level]: (prev.by_level[line.level] ?? 0) + 1 } : prev.by_level,
      by_unit: levelOK ? { ...prev.by_unit, [line.unit]: (prev.by_unit[line.unit] ?? 0) + 1 } : prev.by_unit,
    } : prev));
    if (!unitOK || !levelOK) return;
    setLines((prev) => {
      const next = [...prev, line];
      return next.length > LIMIT ? next.slice(-LIMIT) : next;
    });
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === '/') { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pickUnit = (unit: string | null, additive: boolean) => {
    setUnits((prev) => {
      if (unit === null) return new Set();
      const next = additive ? new Set(prev) : new Set<string>();
      if (additive && next.has(unit)) next.delete(unit); else next.add(unit);
      return next;
    });
  };

  // A line that was JSON is written back as that JSON, so the file holds
  // what the programs wrote and not the console's reading of it.
  const download = () => {
    const text = lines.map((l) =>
      `${dayjs(l.t * 1000).format('YYYY-MM-DD HH:mm:ss')} ${l.label} ${l.level.toUpperCase()} ${l.raw ?? l.text}`,
    ).join('\n');
    const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tenkstack-logs-${dayjs().format('YYYYMMDD-HHmm')}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const byUnit = result?.by_unit ?? {};
  const byLevel = result?.by_level ?? {};
  const total = result?.total ?? 0;
  const notice = useMemo(() => {
    if (!result) return undefined;
    const parts: string[] = [];
    if (result.scan_cap && result.reached) parts.push(`這段太長，只讀到 ${stamp(result.reached)} 為止；縮小範圍或加條件`);
    if (result.truncated && !result.scan_cap) parts.push(`符合 ${total.toLocaleString()} 行，只列最後 ${LIMIT.toLocaleString()} 行`);
    return parts.length ? parts.join('。') : undefined;
  }, [result, total]);

  const emptyText = loading ? '讀取中…'
    : q ? '這段時間裡沒有符合的行'
      : units.size ? '這段時間裡這個來源沒有記錄' : '這段時間裡沒有記錄';

  const journal = sources?.journal;

  return (
    <div style={{
      height: 'calc(100vh - 56px - 48px)', display: 'flex',
      border: `1px solid ${LINE.faint}`, borderRadius: 8, overflow: 'hidden',
      background: 'rgba(255,255,255,0.015)',
    }}>
      {/* ---- sources ---------------------------------------------------- */}
      <aside style={{
        width: SIDEBAR_W, flex: 'none', borderRight: `1px solid ${LINE.faint}`,
        display: 'flex', flexDirection: 'column', minHeight: 0,
      }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 8px' }}>
          <Text type="secondary" style={{ fontSize: 10, letterSpacing: 1.2, display: 'block', padding: '4px 8px' }}>
            來源
          </Text>
          <SourceRow
            label="全部" colour="rgba(255,255,255,0.7)" on={units.size === 0}
            count={Object.values(byUnit).reduce((a, b) => a + b, 0)}
            state="" following
            onClick={() => pickUnit(null, false)}
          />
          {(sources?.sources ?? []).map((s) => (
            <SourceRow
              key={s.unit}
              label={s.kind === 'container' ? `${s.label} ${s.unit.replace(/^comfyui-/, '')}` : s.label}
              title={`${s.unit}\n${s.present ? s.state : '這台機器沒有'}${s.following ? '，正在跟' : ''}`}
              colour={sourceColour(s.unit)}
              count={byUnit[s.unit] ?? 0}
              on={units.has(s.unit)}
              state={s.present ? s.state : 'absent'}
              following={s.following}
              onClick={(e) => pickUnit(s.unit, e.ctrlKey || e.metaKey)}
            />
          ))}
        </div>

        {/* Whether there is a record to read at all, and what is running
            right now. Under the sources so it is always in view. */}
        <div style={{ borderTop: `1px solid ${LINE.faint}`, padding: '10px 12px' }}>
          <Text type="secondary" style={{ fontSize: 10, letterSpacing: 1.2, display: 'block', marginBottom: 4 }}>
            記錄狀態
          </Text>
          {journal ? (
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, display: 'block', lineHeight: 1.6 }}>
              {journal.available
                ? <>journald {journal.persistent ? '持久化' : '只在記憶體'} ・ {journal.disk_usage || '—'}<br />
                    最舊 {journal.oldest ? stamp(journal.oldest) : '—'}</>
                : '這台沒有 journald'}
            </Text>
          ) : <Text type="secondary" style={{ fontSize: 11 }}>—</Text>}
          {requests.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 10, letterSpacing: 1.2, display: 'block', marginBottom: 2 }}>
                進行中 {requests.length}
              </Text>
              {requests.map((r) => (
                <div key={r.id} style={{ display: 'flex', gap: 6, fontSize: 11, fontFamily: MONO, alignItems: 'baseline' }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.8 }}>
                    {r.model ?? r.req_path}
                  </span>
                  <span style={{ opacity: 0.4 }}>{(r.elapsed_ms / 1000).toFixed(0)}s</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ---- main ----------------------------------------------------------- */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          borderBottom: `1px solid ${LINE.faint}`, flex: 'none', flexWrap: 'wrap',
        }}>
          <Segmented size="small" value={windowSec} options={WINDOWS}
                     onChange={(v) => {
                       const n = v as number;
                       setWindowSec(n);
                       if (n < 0 && !custom) {
                         const now = Date.now() / 1000;
                         setCustom([now - 86400, now]);
                       }
                     }} />
          {windowSec < 0 && (
            <DatePicker.RangePicker
              size="small" showTime allowClear={false}
              value={custom ? [dayjs(custom[0] * 1000), dayjs(custom[1] * 1000)] : null}
              onChange={(v) => { if (v && v[0] && v[1]) setCustom([v[0].unix(), v[1].unix()]); }}
            />
          )}
          <Input
            ref={search}
            size="small"
            allowClear
            prefix={<SearchOutlined style={{ opacity: 0.4 }} />}
            placeholder="搜尋這段時間（/）"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            style={{ width: 240, marginLeft: 'auto' }}
          />
          <Tooltip title={windowSec > 0 ? (follow ? '暫停跟隨' : '跟隨新行') : '自訂區間不會有新行'}>
            <Button size="small" type={follow ? 'primary' : 'default'} ghost={follow}
                    icon={follow ? <PauseOutlined /> : <PlayCircleOutlined />}
                    disabled={windowSec < 0} onClick={() => setFollow((v) => !v)}>
              {follow ? '跟隨中' : '已暫停'}
            </Button>
          </Tooltip>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
          borderBottom: `1px solid ${LINE.faint}`, flex: 'none', flexWrap: 'wrap',
        }}>
          {LEVELS.map((lvl) => {
            const on = levels.has(lvl);
            return (
              <Button
                key={lvl} size="small" type={on ? 'default' : 'text'}
                onClick={() => setLevels((prev) => {
                  const next = new Set(prev);
                  if (next.has(lvl)) { if (next.size > 1) next.delete(lvl); } else next.add(lvl);
                  return next;
                })}
                style={{ opacity: on ? 1 : 0.45 }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: LEVEL_COLOUR[lvl], display: 'inline-block', marginRight: 6 }} />
                {LEVEL_LABEL[lvl]}
                <span style={{ fontFamily: MONO, opacity: 0.55, marginLeft: 6 }}>{(byLevel[lvl] ?? 0).toLocaleString()}</span>
              </Button>
            );
          })}
          <span style={{ width: 1, height: 16, background: LINE.faint, margin: '0 4px' }} />
          <Tooltip title="主控台每幾秒對 llama-swap、Caddy 的 GET /running、/v1/models、/health；平常藏著">
            <Button size="small" type={noise ? 'default' : 'text'} onClick={() => setNoise((v) => !v)}
                    style={{ opacity: noise ? 1 : 0.6 }}>
              {noise ? '顯示輪詢中' : '隱藏輪詢'}
            </Button>
          </Tooltip>
          <Button size="small" type={wrap ? 'default' : 'text'} onClick={() => setWrap((v) => !v)}
                  style={{ opacity: wrap ? 1 : 0.6 }}>
            換行
          </Button>
          <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, marginLeft: 'auto' }}>
            {loading ? '讀取中…'
              : result ? `${total.toLocaleString()} 行${result.scanned > total ? ` ・ 掃了 ${result.scanned.toLocaleString()}` : ''}`
                + (loadedAt ? ` ・ ${stamp(result.since)} 起` : '')
                : ''}
          </Text>
          <Tooltip title="重新讀這段時間">
            <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => void run()} />
          </Tooltip>
          <Tooltip title="下載畫面上的行">
            <Button size="small" type="text" icon={<DownloadOutlined />} disabled={!lines.length} onClick={download} />
          </Tooltip>
        </div>

        <LogList lines={lines} follow={follow && windowSec > 0} onFollow={setFollow}
                 wrap={wrap} empty={emptyText} notice={notice} />
      </div>
    </div>
  );
}

function SourceRow({ label, title, colour, count, on, state, following, onClick }: {
  label: string;
  title?: string;
  colour: string;
  count: number;
  on: boolean;
  /** systemd's or docker's word, or 'absent'; empty for the all row. */
  state: string;
  following: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const alive = state === '' || state === 'active' || state === 'running';
  const dot = state === 'absent' ? 'transparent' : alive && following ? ACCENT.ok : LINE.medium;
  return (
    <div
      role="button" tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(e as unknown as React.MouseEvent); }}
      title={title}
      className="lg-source"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 4,
        cursor: 'pointer', fontSize: 12, opacity: state === 'absent' ? 0.4 : 1,
        background: on ? 'rgba(255,255,255,0.08)' : undefined,
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flex: 'none', background: dot,
        border: state === 'absent' ? `1px solid ${LINE.soft}` : 'none',
      }} />
      <span style={{ width: 3, height: 12, borderRadius: 1, background: colour, flex: 'none', opacity: 0.8 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span style={{ fontFamily: MONO, fontSize: 11, opacity: 0.5 }}>
        {state === 'absent' ? '沒有' : !alive ? '停止' : count.toLocaleString()}
      </span>
    </div>
  );
}
