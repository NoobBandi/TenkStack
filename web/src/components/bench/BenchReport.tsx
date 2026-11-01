import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Card, Tooltip, Typography } from 'antd';
import type { BenchCaseResult } from '../../api';
import { CopyOutlined } from '@ant-design/icons';
import {
  CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import { LINE, MONO, SURFACE } from '../../theme';
import { BarLine } from './Bars';
import { ColTitle, Readout } from './BenchResults';
import { CompareTable, type Measure, type TableLine } from './CompareTable';
import { RUN_MARKS, TERMS, fmtPromptTps, fmtTps } from './labels';
import { MarkSlot, Row } from './motion';
import {
  ANSWER_TOKENS, AXIS_TICK, CONTENT_TESTS, DEPTH_TESTS, STREAM_TESTS, answerSeconds, chatVerdict, contentRows,
  contentVerdict, copyText, crowdVerdict, depthRows, find, fmtTimes, headerParts, headline,
  longVerdict, markdown, niceAxis, scaleTop, streamRows, testName, topStreams, tpot,
  type RunView, type StreamRow,
} from './metrics';

const { Text } = Typography;

const colour = (mark: number) => RUN_MARKS[mark]?.colour;
/** The wait before the first word: not a run's identity, so not its colour. */
const WAIT_FILL = 'rgba(255,255,255,0.3)';
const CHART_H = 150;
/** Lines draw in and slide to new values when a run joins; quick enough not
 *  to hold up reading. */
const LINE_MOTION = { isAnimationActive: true, animationDuration: 450, animationEasing: 'ease-out' as const };
const activeRuns = (runs: RunView[]) => runs.filter((v) => !v.leaving);
/** Whether more than one run is being compared, counting only those staying. */
const comparing = (runs: RunView[]) => activeRuns(runs).length > 1;

const secs = (s: number) => (s < 10 ? s.toFixed(1) : Math.round(s).toLocaleString());

/** The width something has, which is not the window's: a block puts its
 *  chart beside its table only when it has the room. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const watch = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Who ran what, on what: one line per run, its letter first when comparing.
 *  The page's header, and the legend for every block below it. */
export function RunHeader({ runs }: { runs: RunView[] }) {
  const many = comparing(runs);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {runs.map((v) => (
        <Row key={v.key} leaving={v.leaving}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0, padding: '2px 0' }}>
            <MarkSlot mark={v.mark} show={many} />
            <Text strong style={{ fontSize: 14 }}>{v.name}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{headerParts(v).join(' · ')}</Text>
          </div>
        </Row>
      ))}
    </div>
  );
}

/** A large figure with its unit and what it is. */
function Figure({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        {value && <span style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>{value}</span>}
        {unit && <Text type="secondary" style={{ fontSize: 12 }}>{unit}</Text>}
      </div>
      <Text type="secondary" style={{ fontSize: 11 }}>{label}</Text>
    </div>
  );
}

/** The headline figures, a row per run -- the same row alone or compared,
 *  so a second run adds a row under the first instead of rearranging the
 *  card. Figures keep fixed widths so A's and B's line up as columns. */
function Headlines({ runs, figures }: {
  runs: RunView[];
  figures: (v: RunView) => { value: string; unit: string; label: string }[];
}) {
  const many = comparing(runs);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {runs.map((v) => (
        <Row key={v.key} leaving={v.leaving}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 0' }}>
            <MarkSlot mark={v.mark} show={many} />
            {/* Fixed columns, packed left: spread over the block's full
                width, two figures sat a screen apart. */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 150px)', gap: 16, flex: 1, minWidth: 0 }}>
              {figures(v).map((f) => <Figure key={f.label} {...f} />)}
            </div>
          </div>
        </Row>
      ))}
    </div>
  );
}

/** The conclusion, one sentence per run, its letter in front when comparing. */
function Verdicts({ runs, say }: { runs: RunView[]; say: (v: RunView) => string | undefined }) {
  const lines = runs.map((v) => ({ v, text: say(v) })).filter((l) => l.text);
  if (!lines.length) return null;
  const many = comparing(runs);
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {lines.map(({ v, text }) => (
        <Row key={v.key} leaving={v.leaving}>
          <div style={{ display: 'flex', gap: 2, alignItems: 'baseline', padding: '2px 0' }}>
            <MarkSlot mark={v.mark} show={many} align="flex-start" />
            <Text style={{ fontSize: 13, lineHeight: 1.6 }}>{text}</Text>
          </div>
        </Row>
      ))}
    </div>
  );
}

const tooltipBox = (heading: string, rows: Parameters<typeof Readout>[0]['rows']) => (
  <Readout heading={heading} rows={rows} />
);

// --- Single user (「單人對話」) ---------------------------------------------

/**
 * A 500-token answer as a timeline, one bar per run on one time scale: the
 * wait for the first word in grey, then the generation in the run's colour.
 * The two moments a person notices are written under the bar where they
 * happen -- the first word, the answer done -- instead of in a legend that
 * had to be decoded first; the grey sliver alone said nothing.
 */
const AnswerTimeline = memo(function AnswerTimeline({ runs }: { runs: RunView[] }) {
  const [ref, width] = useWidth();
  const rows = runs.map((v) => ({ v, t: answerSeconds(headline(v.results)) }));
  const max = Math.max(0, ...rows.filter((r) => !r.v.leaving).map((r) => r.t?.total ?? 0));
  const many = comparing(runs);
  // One scale for every run, with room past the longest for its label.
  const top = max * 1.04;
  const lead = many ? 26 : 0;
  return (
    <div ref={ref} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Text type="secondary" style={{ fontSize: 11, marginBottom: 4 }}>
        一段 {ANSWER_TOKENS} token（一則中等長度的回覆）從送出到寫完
      </Text>
      {max > 0 && rows.map(({ v, t }) => {
        const fill = t ? Math.min(1, t.total / top) : 0;
        // Both labels fit under a bar this long; a shorter one gets them as
        // one line from its start.
        const roomy = (width - lead) * fill >= 250;
        return (
          <Row key={v.key} leaving={v.leaving}>
            <div style={{ display: 'flex', alignItems: 'flex-start', padding: '4px 0 6px' }}>
              <MarkSlot mark={v.mark} show={many} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {t ? (
                  <div className="bn-bar" style={{ width: `${fill * 100}%` }}>
                    <div style={{ display: 'flex', gap: 2, height: 20 }}>
                      <Tooltip title={`等第一個字（TTFT）${secs(t.wait)} 秒`}>
                        <div style={{ flex: `${t.wait} 0 0`, minWidth: 4, background: WAIT_FILL, borderRadius: '3px 0 0 3px' }} />
                      </Tooltip>
                      <Tooltip title={`生成 ${ANSWER_TOKENS} token 花 ${secs(t.gen)} 秒（${fmtTps(headline(v.results).decode)} tok/s）`}>
                        <div style={{ flex: `${t.gen} 0 0`, minWidth: 4, background: colour(v.mark), borderRadius: '0 3px 3px 0' }} />
                      </Tooltip>
                    </div>
                    {roomy ? (
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 4 }}>
                        <Moment at="start" value={t.wait.toFixed(1)} what="第一個字出現" />
                        <Moment at="end" value={t.total.toFixed(1)} what="回答寫完" strong />
                      </div>
                    ) : (
                      <div style={{ marginTop: 4, whiteSpace: 'nowrap' }}>
                        <Moment at="start" value={t.wait.toFixed(1)} what="出第一個字" />
                        <Text type="secondary" style={{ fontSize: 11 }}>・</Text>
                        <Moment value={t.total.toFixed(1)} what="寫完" strong />
                      </div>
                    )}
                  </div>
                ) : <Text type="secondary" style={{ fontSize: 12 }}>沒有 1k 的量測</Text>}
              </div>
            </div>
          </Row>
        );
      })}
    </div>
  );
});

/** A moment on the answer timeline, written under the bar where it falls:
 *  a tick up to the bar, the seconds, and what happens then. */
function Moment({ at, value, what, strong }: { at?: 'start' | 'end'; value: string; what: string; strong?: boolean }) {
  const tick = <span style={{ display: 'inline-block', width: 1, height: 8, background: 'rgba(255,255,255,0.45)', alignSelf: 'flex-start' }} />;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, whiteSpace: 'nowrap' }}>
      {at === 'start' && tick}
      <span style={{ fontSize: 12, fontFamily: MONO, fontWeight: strong ? 600 : 400 }}>{value} 秒</span>
      <Text type="secondary" style={{ fontSize: 11 }}>{what}</Text>
      {at === 'end' && tick}
    </span>
  );
}

// --- Concurrent users (「多人同時」) ----------------------------------------

/** Chart props that are objects, made once: recharts redraws -- and replays
 *  its line animation -- when one of them is a new object, which inline
 *  literals are on every render, and the page renders every two seconds
 *  for the run status. That replay was the endpoint value blinking out. */
const CHART_MARGIN = { top: 14, right: 48, left: 0, bottom: 0 };
const CURSOR = { stroke: LINE.strong, strokeWidth: 1 };
const X_TICK = { ...AXIS_TICK, fill: 'rgba(255,255,255,0.65)' };

/** The same array as last time when the content is the same, so a parent
 *  rebuilding equal data does not restart an animation. */
function useSteady<T>(value: T): T {
  const last = useRef<{ sig: string; value: T } | null>(null);
  const sig = JSON.stringify(value);
  if (last.current?.sig !== sig) last.current = { sig, value };
  return last.current.value;
}

/**
 * Where each run's value goes at the right end of a line chart: beside its
 * last point, nudged apart when two would print over each other.
 */
function endOffsets(ends: { key: string; value: number | undefined }[], top: number, plotHeight: number) {
  const placed = ends
    .filter((e): e is { key: string; value: number } => e.value !== undefined)
    .map((e) => ({ key: e.key, y: plotHeight - (e.value / top) * plotHeight }))
    .sort((a, b) => a.y - b.y);
  const out: Record<string, number> = {};
  let floor = -Infinity;
  for (const p of placed) {
    const y = Math.max(p.y, floor + 13);
    out[p.key] = y - p.y;
    floor = y;
  }
  return out;
}

/** The value at a line's last point, for LabelList's content. */
function endLabel(last: number, shift: number) {
  return function EndLabel(p: unknown) {
    const { x, y, value, index } = p as { x?: number; y?: number; value?: number; index?: number };
    if (index !== last || value === undefined || x === undefined || y === undefined) return null;
    return (
      <text x={Number(x) + 8} y={Number(y) + 4 + shift} fill="rgba(255,255,255,0.85)" fontSize={11} fontFamily={MONO}>
        {fmtTps(value)}
      </text>
    );
  };
}

/**
 * Total generation by how many people use it at once, each run's ideal --
 * N times its own one-person speed -- dashed beside it. The people go on a
 * number line, so 4 sits twice as far out as 2 and the ideal is straight;
 * spaced as categories, 1, 2 and 4 bent it.
 */
const CrowdChart = memo(function CrowdChart({ runs: all }: { runs: RunView[] }) {
  const [ref, width] = useWidth();
  const runs = activeRuns(all);
  const data = useSteady(useMemo(() => {
    const streams = [...new Set(runs.flatMap((v) => streamRows(v.results).map((s) => s.streams)))].sort((a, b) => a - b);
    return streams.map((n) => {
      const row: Record<string, number | undefined> = { n };
      for (const v of runs) {
        const rows = streamRows(v.results);
        const one = rows.find((r) => r.streams === 1);
        row[`a${v.key}`] = rows.find((r) => r.streams === n)?.total;
        row[`i${v.key}`] = one ? one.decode * n : undefined;
      }
      return row;
    });
  }, [runs]));
  if (data.length < 2) return null;
  const people = data.map((row) => row.n as number);
  const axis = niceAxis(data.flatMap((row) => runs.flatMap((v) => [row[`a${v.key}`], row[`i${v.key}`]])));
  const top = axis.ticks[axis.ticks.length - 1];
  // Taller when the block gives it the whole width, so it is not a strip.
  const height = width > 720 ? 210 : 170;
  const last = data.length - 1;
  const shifts = endOffsets(runs.map((v) => ({ key: v.key, value: data[last][`a${v.key}`] })), top, height - 14 - 22);
  return (
    <div ref={ref}>
      <Text type="secondary" style={{ fontSize: 11 }}>總吞吐 tok/s，依同時使用的人數</Text>
      <ResponsiveContainer width="100%" height={height} debounce={250}>
        <LineChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid stroke={LINE.faint} vertical={false} />
          <XAxis dataKey="n" type="number" domain={[people[0], people[people.length - 1]]} ticks={people}
                 tickFormatter={(n: number) => `${n} 人`} padding={{ left: 10, right: 10 }}
                 stroke={LINE.soft} tick={X_TICK} tickLine={false} height={22} />
          <YAxis stroke={LINE.soft} tick={AXIS_TICK} tickLine={false} width={40}
                 domain={[0, top]} ticks={axis.ticks} tickFormatter={axis.label} />
          <ChartTooltip
            cursor={CURSOR}
            content={({ active, label, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as Record<string, number | undefined>;
              return tooltipBox(`${label} 人同時・總吞吐`, runs.map((v) => ({
                key: v.key, colour: colour(v.mark),
                value: row[`a${v.key}`] !== undefined ? `${fmtTps(row[`a${v.key}`])} tok/s` : '—',
                label: `${runs.length > 1 ? `${RUN_MARKS[v.mark]?.letter} ` : ''}理想 ${fmtTps(row[`i${v.key}`])}`,
              })));
            }}
          />
          {runs.map((v) => (
            <Line key={`i${v.key}`} dataKey={`i${v.key}`} stroke={colour(v.mark)} strokeOpacity={0.45}
                  strokeDasharray="4 4" strokeWidth={1.5} dot={false} activeDot={false}
                  {...LINE_MOTION} connectNulls />
          ))}
          {runs.map((v) => (
            <Line key={`a${v.key}`} dataKey={`a${v.key}`} stroke={colour(v.mark)} strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round"
                  dot={{ r: 4, fill: colour(v.mark), stroke: SURFACE.card, strokeWidth: 2 }}
                  activeDot={{ r: 5, fill: colour(v.mark), stroke: SURFACE.card, strokeWidth: 2 }}
                  {...LINE_MOTION} connectNulls>
              <LabelList dataKey={`a${v.key}`} content={endLabel(last, shifts[v.key] ?? 0)} />
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="rgba(255,255,255,0.75)" strokeWidth="2" /></svg>
          <Text type="secondary" style={{ fontSize: 11 }}>實際總吞吐</Text>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeDasharray="4 4" /></svg>
          <Text type="secondary" style={{ fontSize: 11 }}>理想：人數 × 1 人時的速度</Text>
        </span>
      </div>
    </div>
  );
});

// --- Long context (「長文」) ------------------------------------------------

/** Decode against context depth, one line per run that measured more than
 *  one depth; the first-token wait at each depth is in the table beside it
 *  rather than on a second axis. */
const LongChart = memo(function LongChart({ runs: all }: { runs: RunView[] }) {
  const runs = activeRuns(all);
  const deep = runs.filter((v) => depthRows(v.results).length > 1);
  const data = useSteady(useMemo(() => DEPTH_TESTS
    .filter((d) => deep.some((v) => find(v.results, d.id)))
    .map((d) => {
      const row: Record<string, string | number | undefined> = { x: d.short };
      for (const v of deep) row[`d${v.key}`] = find(v.results, d.id)?.gen_tps;
      return row;
    }), [deep]));
  const axis = niceAxis(data.flatMap((row) => deep.map((v) => row[`d${v.key}`] as number | undefined)));
  const top = axis.ticks[axis.ticks.length - 1];
  const height = CHART_H - 10;
  const last = data.length - 1;
  const shifts = endOffsets(deep.map((v) => ({ key: v.key, value: data[last]?.[`d${v.key}`] as number | undefined })), top, height - 14 - 22);
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 11 }}>Decode tok/s，依上下文長度</Text>
      <ResponsiveContainer width="100%" height={height} debounce={250}>
        <LineChart data={data} margin={CHART_MARGIN}>
          <CartesianGrid stroke={LINE.faint} vertical={false} />
          <XAxis dataKey="x" stroke={LINE.soft} tick={X_TICK} tickLine={false} height={22} />
          <YAxis stroke={LINE.soft} tick={AXIS_TICK} tickLine={false} width={40}
                 domain={[0, top]} ticks={axis.ticks} tickFormatter={axis.label} />
          <ChartTooltip
            cursor={CURSOR}
            content={({ active, label, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as Record<string, number | undefined>;
              return tooltipBox(`${label} 上下文`, deep.map((v) => {
                const r = find(v.results, DEPTH_TESTS.find((d) => d.short === label)?.id ?? '');
                return {
                  key: v.key, colour: colour(v.mark),
                  value: row[`d${v.key}`] !== undefined ? `${fmtTps(row[`d${v.key}`])} tok/s` : '—',
                  label: r ? `TTFT ${secs(r.ttft_ms / 1000)} 秒` : undefined,
                };
              }));
            }}
          />
          {deep.map((v) => (
            <Line key={`d${v.key}`} dataKey={`d${v.key}`} stroke={colour(v.mark)} strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round"
                  dot={{ r: 4, fill: colour(v.mark), stroke: SURFACE.card, strokeWidth: 2 }}
                  activeDot={{ r: 5, fill: colour(v.mark), stroke: SURFACE.card, strokeWidth: 2 }}
                  {...LINE_MOTION} connectNulls>
              <LabelList dataKey={`d${v.key}`} content={endLabel(last, shifts[v.key] ?? 0)} />
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
});

// --- Content types (「內容類型」) -------------------------------------------

/** Decode per content type as horizontal bars: a row per content, a bar
 *  per run inside it, every bar on one scale. The acceptance rate is in the
 *  table beside it. */
function ContentChart({ runs }: { runs: RunView[] }) {
  const active = activeRuns(runs);
  const kinds = CONTENT_TESTS.filter((c) => active.some((v) => find(v.results, c.id)));
  const top = scaleTop(kinds.flatMap((c) => active.map((v) => find(v.results, c.id)?.gen_tps)));
  const many = comparing(runs);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {kinds.map((c) => {
        return (
          <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0, 1fr)', gap: 8, alignItems: 'center' }}>
            <Text style={{ fontSize: 12 }}>{c.label}</Text>
            <div>
              {runs.map((v) => {
                const r = find(v.results, c.id);
                return (
                  <BarLine
                    key={v.key} run={v} comparing={many} top={top} height={10}
                    value={r?.gen_tps} text={fmtTps(r?.gen_tps)}
                    tip={r ? `${many ? `${RUN_MARKS[v.mark]?.letter}・` : ''}${c.label} Decode ${fmtTps(r.gen_tps)} tok/s`
                      + (r.accept_rate != null ? `，接受率 ${Math.round(r.accept_rate * 100)}%` : '') : undefined}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
      <Text type="secondary" style={{ fontSize: 11 }}>Decode tok/s</Text>
    </div>
  );
}

// --- The four sections (「四個區塊」) ---------------------------------------

/**
 * One of the four blocks: the situation and the question it answers, the
 * headline figures and a sentence per run, then its chart beside its own
 * numbers -- the table that used to be one long one at the foot of the
 * page, cut into the four places it is read.
 */
function Block({ title, question, empty, headlines, verdicts, chart, table, columns = 0, stack, runs }: {
  title: string; question: string; empty?: string; runs: RunView[];
  headlines?: React.ReactNode; verdicts?: React.ReactNode; chart?: React.ReactNode; table?: React.ReactNode;
  /** How many figure columns the table has; past six it takes the full
   *  width under the chart rather than being cut off beside it. */
  columns?: number;
  /** The table under the chart however wide the block is: a one-row table
   *  beside a short chart left half the card empty. */
  stack?: boolean;
}) {
  const [ref, width] = useWidth();
  const side = !stack && width >= 860 && columns <= 6;
  return (
    <Card
      size="small"
      title={(
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span>{title}</span>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{question}</Text>
        </span>
      )}
    >
      <div ref={ref} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {empty ? <Text type="secondary" style={{ fontSize: 13, padding: '8px 0' }}>{empty}</Text> : (
          <>
            {headlines}
            {verdicts}
            <div style={{
              display: 'grid', gap: 24, alignItems: 'start',
              gridTemplateColumns: side ? 'minmax(0, 5fr) minmax(0, 6fr)' : 'minmax(0, 1fr)',
            }}>
              <div style={{ minWidth: 0 }}>{chart}</div>
              {/* Keyed on how many runs are compared, not which: a run read
                  in another's place changes the numbers in place, while a
                  table that gains or loses columns fades in. */}
              <div key={activeRuns(runs).length} className="bn-fade" style={{ minWidth: 0 }}>
                {table}
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** The one-stream 1k measurement, wherever the run reported it. */
const base1k = (v: RunView) => find(v.results, 'depth-1k') ?? find(v.results, 'conc-1') ?? find(v.results, 'content-en');
const sec2 = (v: number) => (v < 10 ? v.toFixed(2) : v.toFixed(1));

function ChatBlock({ runs }: { runs: RunView[] }) {
  // One condition, one row, its figures across -- the other three blocks'
  // tables turned the same way -- under the timeline rather than beside it.
  const lines: TableLine<BenchCaseResult>[] = [{
    key: '1k',
    label: (
      <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.3 }}>
        <span>1 人・1k</span>
        <Text type="secondary" style={{ fontSize: 10, fontFamily: MONO }}>{testName(DEPTH_TESTS[0].pp)}</Text>
      </span>
    ),
    pick: base1k,
  }];
  const measures: Measure<BenchCaseResult>[] = [
    { key: 'ttft', title: <ColTitle en="TTFT" unit="秒" zh="首字延遲" tip={TERMS.ttft} />,
      value: (r) => r.ttft_ms / 1000, text: sec2, better: 'lower' },
    { key: 'pp', title: <ColTitle en="Prefill" unit="tok/s" zh="讀入提示" tip={TERMS.prefill} />,
      value: (r) => r.prompt_tps, text: fmtPromptTps, better: 'higher' },
    { key: 'tg', title: <ColTitle en="Decode" unit="tok/s" zh="生成速度" tip={TERMS.decode} />,
      value: (r) => r.gen_tps, text: fmtTps, better: 'higher' },
    { key: 'tpot', title: <ColTitle en="TPOT" unit="ms" zh="每個 token" tip="開始生成之後，平均每個 token 花幾毫秒，等於 1000 ÷ Decode。" />,
      value: (r) => tpot(r), text: fmtTps, better: 'lower' },
    { key: 'answer', title: <ColTitle en="Answer" unit="秒" zh={`${ANSWER_TOKENS} token 回答`} tip={`等第一個字的時間，加上生成 ${ANSWER_TOKENS} token 的時間。`} />,
      value: (r) => answerSeconds({ decode: r.gen_tps, ttft: r.ttft_ms })?.total, text: (v) => v.toFixed(1), better: 'lower' },
  ];
  return (
    <Block
      runs={runs}
      title="單人對話" question="一個人聊天時，回覆快不快？"
      empty={runs.some((v) => base1k(v)) ? undefined : '這次沒有量 1k 單人。'}
      headlines={<Headlines runs={runs} figures={(v) => {
        const h = headline(v.results);
        return [
          { value: h.ttft !== undefined ? secs(h.ttft / 1000) : '—', unit: '秒', label: 'TTFT 第一個字' },
          { value: fmtTps(h.decode), unit: 'tok/s', label: 'Decode 生成' },
        ];
      }} />}
      verdicts={<Verdicts runs={runs} say={(v) => chatVerdict(headline(v.results))} />}
      chart={<AnswerTimeline runs={runs} />}
      stack
      table={<CompareTable runs={runs} lines={lines} measures={measures}
                           labelTitle={<ColTitle en="Test" zh="測試" tip={TERMS.depth} />} />}
    />
  );
}

const QUICK_ONLY = '這次只測了 1k。用完整檔，或自訂勾選更長的上下文，才看得到上下文變長後慢多少。';

function LongBlock({ runs }: { runs: RunView[] }) {
  const any = runs.some((v) => depthRows(v.results).length > 1);
  const lines: TableLine<BenchCaseResult>[] = DEPTH_TESTS
    .filter((d) => runs.some((v) => find(v.results, d.id)))
    .map((d) => ({
      key: d.id,
      label: (
        <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.3 }}>
          <span>{d.short}</span>
          <Text type="secondary" style={{ fontSize: 10, fontFamily: MONO }}>{testName(d.pp)}</Text>
        </span>
      ),
      pick: (v) => find(v.results, d.id),
    }));
  const measures: Measure<BenchCaseResult>[] = [
    { key: 'ttft', title: <ColTitle en="TTFT" unit="秒" zh="首字延遲" tip={TERMS.ttft} />,
      value: (r) => r.ttft_ms / 1000, text: sec2, better: 'lower' },
    { key: 'pp', title: <ColTitle en="Prefill" unit="tok/s" zh="讀入提示" tip={TERMS.prefill} />,
      value: (r) => r.prompt_tps, text: fmtPromptTps, better: 'higher' },
    { key: 'tg', title: <ColTitle en="Decode" unit="tok/s" zh="生成速度" tip={TERMS.decode} />,
      value: (r) => r.gen_tps, text: fmtTps, better: 'higher' },
  ];
  return (
    <Block
      runs={runs}
      title="長文" question="貼進很長的文件、或對話拉得很長時，會慢多少？"
      empty={any ? undefined : QUICK_ONLY}
      headlines={<Headlines runs={runs} figures={(v) => {
        const rows = depthRows(v.results);
        const deep = rows[rows.length - 1];
        if (!deep || rows.length < 2) return [{ value: '', unit: '', label: '只測 1k' }];
        return [
          { value: fmtTps(deep.r.gen_tps), unit: 'tok/s', label: `${deep.short} Decode` },
          { value: secs(deep.r.ttft_ms / 1000), unit: '秒', label: `${deep.short} TTFT` },
        ];
      }} />}
      verdicts={<Verdicts runs={runs} say={(v) => longVerdict(v.results) ?? '快速檔只測 1k，沒有長文的數字。'} />}
      chart={<LongChart runs={runs} />}
      columns={measures.length * activeRuns(runs).length}
      table={<CompareTable runs={runs} lines={lines} measures={measures}
                           labelTitle={<ColTitle en="Context" zh="上下文" tip={TERMS.depth} />} />}
    />
  );
}

function CrowdBlock({ runs }: { runs: RunView[] }) {
  const any = runs.some((v) => topStreams(v.results));
  const lines: TableLine<StreamRow>[] = STREAM_TESTS
    .filter((t) => runs.some((v) => find(v.results, t.id)))
    .map((t) => ({
      key: t.id,
      label: t.streams === 1 ? '1 人' : `${t.streams} 人同時`,
      pick: (v) => streamRows(v.results).find((s) => s.id === t.id),
    }));
  const measures: Measure<StreamRow>[] = [
    { key: 'total', title: <ColTitle en="Total" unit="tok/s" zh="總吞吐" tip={TERMS.total} />,
      value: (s) => s.total, text: fmtTps, better: 'higher' },
    { key: 'each', title: <ColTitle en="Decode" unit="tok/s" zh="每人" tip={TERMS.decode} />,
      value: (s) => s.decode, text: fmtTps, better: 'higher' },
    { key: 'x', title: <ColTitle en="Speedup" zh="對單人" tip="總吞吐 ÷ 單人的 Decode；4 人時接近 4 表示多人共用不吃虧，接近 1 表示一次只服務一人。" />,
      value: (s) => s.speedup, text: (v) => `×${v.toFixed(2)}`, better: 'higher' },
    { key: 'ttft', title: <ColTitle en="TTFT" unit="秒" zh="平均首字" tip={TERMS.ttft} />,
      value: (s) => s.r.ttft_ms / 1000, text: sec2, better: 'lower' },
  ];
  return (
    <Block
      runs={runs}
      title="多人同時" question="幾個人同時用，會不會互相拖慢？"
      empty={any ? undefined : '這次沒有量多人同時。'}
      headlines={<Headlines runs={runs} figures={(v) => {
        const top = topStreams(v.results);
        if (!top) return [{ value: '', unit: '', label: '沒有量多路' }];
        return [
          { value: fmtTps(top.total), unit: 'tok/s', label: `${top.streams} 人總吞吐` },
          { value: fmtTps(top.decode), unit: 'tok/s', label: '每人 Decode' },
          { value: fmtTimes(top.speedup), unit: '', label: 'Speedup' },
        ];
      }} />}
      verdicts={<Verdicts runs={runs} say={(v) => crowdVerdict(v.results)} />}
      chart={<CrowdChart runs={runs} />}
      columns={measures.length * activeRuns(runs).length}
      table={<CompareTable runs={runs} lines={lines} measures={measures}
                           labelTitle={<ColTitle en="Users" zh="人數" tip={TERMS.streams} />} />}
    />
  );
}

/** A content row with its rate against Chinese, the slowest as a rule. */
interface ContentLine { rate: number; accept?: number; vsZh?: number }

function ContentBlock({ runs }: { runs: RunView[] }) {
  // English alone is the base every run has; the block compares contents.
  const any = runs.some((v) => contentRows(v.results).length > 1);
  const pick = (id: string) => (v: RunView): ContentLine | undefined => {
    const rows = contentRows(v.results);
    const c = rows.find((x) => x.id === id);
    if (!c) return undefined;
    const zh = rows.find((x) => x.id === 'content-zh');
    return {
      rate: c.r.gen_tps,
      accept: c.r.accept_rate == null ? undefined : c.r.accept_rate * 100,
      vsZh: zh && zh.r.gen_tps > 0 ? c.r.gen_tps / zh.r.gen_tps : undefined,
    };
  };
  const lines: TableLine<ContentLine>[] = CONTENT_TESTS
    .filter((c) => runs.some((v) => find(v.results, c.id)))
    .map((c) => ({ key: c.id, label: c.label, pick: pick(c.id) }));
  const hasAccept = runs.some((v) => (v.results ?? []).some((r) => r.accept_rate != null));
  const measures: Measure<ContentLine>[] = [
    { key: 'tg', title: <ColTitle en="Decode" unit="tok/s" zh="生成速度" tip={TERMS.decode} />,
      value: (c) => c.rate, text: fmtTps, better: 'higher' },
    { key: 'zh', title: <ColTitle en="vs 中文" zh="對中文" tip="這種內容的 Decode ÷ 中文的 Decode。" />,
      value: (c) => c.vsZh, text: (v) => `×${v.toFixed(2)}`, better: 'higher' },
    ...(hasAccept ? [{ key: 'acc', title: <ColTitle en="Accept" zh="推測接受率" tip={TERMS.accept} />,
      value: (c: ContentLine) => c.accept, text: (v: number) => `${Math.round(v)}%`, better: 'higher' as const }] : []),
  ];
  return (
    <Block
      runs={runs}
      title="內容類型" question="中文、英文、程式碼，哪一種生成最快？"
      empty={any ? undefined : '這次沒有量內容類型。'}
      headlines={<Headlines runs={runs} figures={(v) => {
        const rows = contentRows(v.results);
        if (!rows.length) return [{ value: '', unit: '', label: '沒有量' }];
        const zh = rows.find((c) => c.id === 'content-zh');
        const fastest = rows.reduce((a, b) => (b.r.gen_tps > a.r.gen_tps ? b : a));
        return [
          { value: fmtTps(zh?.r.gen_tps), unit: 'tok/s', label: '中文' },
          { value: fmtTps(fastest.r.gen_tps), unit: 'tok/s', label: `最快：${fastest.label}` },
        ];
      }} />}
      verdicts={<Verdicts runs={runs} say={(v) => contentVerdict(v.results)} />}
      chart={<ContentChart runs={runs} />}
      columns={measures.length * activeRuns(runs).length}
      table={<CompareTable runs={runs} lines={lines} measures={measures}
                           labelTitle={<ColTitle en="Content" zh="內容" tip={TERMS.content} />} />}
    />
  );
}

/** 複製成文字: the verdicts and the tables as Markdown, for a chat or an issue. */
export function CopyReport({ runs }: { runs: RunView[] }) {
  const { message } = AntApp.useApp();
  const copy = async () => {
    const text = markdown(activeRuns(runs), (m) => RUN_MARKS[m]?.letter ?? '?');
    if (await copyText(text)) message.success('已複製成 Markdown');
    else message.error('瀏覽器不讓複製，請改用匯出');
  };
  return <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()}>複製成文字</Button>;
}

/**
 * The result in four blocks, one per situation that matters -- one person
 * chatting, a long context, several at once, the kind of text -- each with
 * its figures, a sentence of conclusion, a chart and its own numbers.
 */
export default function BenchReport({ runs }: { runs: RunView[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ChatBlock runs={runs} />
      <LongBlock runs={runs} />
      <CrowdBlock runs={runs} />
      <ContentBlock runs={runs} />
    </div>
  );
}
