import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Card, Tooltip, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import {
  CartesianGrid, LabelList, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import { LINE, MONO, SURFACE } from '../../theme';
import { BarLine } from './Bars';
import { Readout } from './BenchResults';
import { RUN_MARKS, fmtTps } from './labels';
import { MarkSlot, Row } from './motion';
import {
  ANSWER_TOKENS, AXIS_TICK, CONTENT_TESTS, DEPTH_TESTS, answerSeconds, chatVerdict, contentRows,
  contentVerdict, copyText, crowdVerdict, depthRows, find, fmtTimes, headerParts, headline,
  longVerdict, markdown, niceAxis, scaleTop, streamRows, topStreams, type RunView,
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

/** The width something has, which is not the window's: beside the list the
 *  report is a third narrower than stacked under it. */
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
 *  This is the legend for every card below. */
function RunHeader({ runs }: { runs: RunView[] }) {
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, flex: 1, minWidth: 0 }}>
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

/** One scenario: what it is, the question it answers, the figures, the
 *  verdict, and one chart. Four of these, all the same size. */
function Scenario({ title, question, children }: {
  title: string; question: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      border: `1px solid ${LINE.faint}`, borderRadius: 6, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0,
    }}>
      <div>
        <Text strong style={{ fontSize: 14 }}>{title}</Text>
        <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{question}</Text>
      </div>
      {children}
    </div>
  );
}

/** The chart slot, pushed to the bottom of its card so the four charts of a
 *  row line up whatever the verdicts above them run to. */
function ChartSlot({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 'auto', minWidth: 0 }}>{children}</div>;
}

const tooltipBox = (heading: string, rows: Parameters<typeof Readout>[0]['rows']) => (
  <Readout heading={heading} rows={rows} />
);

// --- 單人對話 ---------------------------------------------------------------

/**
 * A 500-token answer as a timeline: the wait for the first word, then the
 * generation, on one time scale shared by every run, the total at the end.
 * The wait is grey for every run -- it is the same thing for all of them --
 * and the generation wears the run's colour.
 */
function AnswerTimeline({ runs }: { runs: RunView[] }) {
  const rows = runs.map((v) => ({ v, t: answerSeconds(headline(v.results)) }));
  const max = Math.max(0, ...rows.filter((r) => !r.v.leaving).map((r) => r.t?.total ?? 0));
  if (!max) return null;
  // One time scale for every run, ending at a round number of seconds.
  const axis = niceAxis([max], 4);
  const top = axis.ticks[axis.ticks.length - 1];
  const many = comparing(runs);
  const lead = many ? 26 : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(({ v, t }) => (
        <Row key={v.key} leaving={v.leaving}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 0' }}>
          <MarkSlot mark={v.mark} show={many} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            {t ? (
              <>
                <div className="bn-bar" style={{ width: `calc((100% - 52px) * ${Math.min(1, t.total / top)})`, display: 'flex', gap: 2, height: 18 }}>
                  <Tooltip title={`等待第一個字（TTFT）${secs(t.wait)} 秒`}>
                    <div style={{ flex: `${t.wait} 0 0`, minWidth: 2, background: WAIT_FILL }} />
                  </Tooltip>
                  <Tooltip title={`生成 ${ANSWER_TOKENS} token：${secs(t.gen)} 秒（${fmtTps(headline(v.results).decode)} tok/s）`}>
                    <div style={{ flex: `${t.gen} 0 0`, minWidth: 2, background: colour(v.mark), borderRadius: '0 4px 4px 0' }} />
                  </Tooltip>
                </div>
                <Text style={{ fontSize: 12, fontFamily: MONO, whiteSpace: 'nowrap' }}>{secs(t.total)} 秒</Text>
              </>
            ) : <Text type="secondary" style={{ fontSize: 12 }}>沒有 1k 的量測</Text>}
          </div>
        </div>
        </Row>
      ))}
      {/* The time scale: hairline ticks at round seconds under the bars. */}
      <div style={{
        position: 'relative', height: 16, marginTop: 4, marginInlineStart: lead,
        width: `calc(100% - ${lead}px - 52px)`, transition: 'margin 0.3s, width 0.3s',
      }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, borderTop: `1px solid ${LINE.soft}` }} />
        {axis.ticks.map((tick) => (
          <span key={tick} style={{
            position: 'absolute', left: `${(tick / top) * 100}%`, top: 2,
            transform: tick === 0 ? undefined : 'translateX(-50%)',
            fontSize: 10, fontFamily: MONO, color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap',
          }}>
            {tick}{tick === top ? ' 秒' : ''}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 2 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, background: WAIT_FILL, borderRadius: 2 }} />
          <Text type="secondary" style={{ fontSize: 11 }}>等待第一個字</Text>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, background: many ? 'rgba(255,255,255,0.65)' : colour(runs[0].mark), borderRadius: 2 }} />
          <Text type="secondary" style={{ fontSize: 11 }}>生成 {ANSWER_TOKENS} token</Text>
        </span>
        {!many && rows[0].t && (
          <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
            {secs(rows[0].t.wait)} 秒 + {secs(rows[0].t.gen)} 秒
          </Text>
        )}
      </div>
    </div>
  );
}

function ChatCard({ runs }: { runs: RunView[] }) {
  return (
    <Scenario title="單人對話" question="一個人聊天時，回覆快不快？">
      <Headlines runs={runs} figures={(v) => {
        const h = headline(v.results);
        return [
          { value: h.ttft !== undefined ? secs(h.ttft / 1000) : '—', unit: '秒', label: 'TTFT 第一個字' },
          { value: fmtTps(h.decode), unit: 'tok/s', label: 'Decode 生成' },
        ];
      }} />
      <Verdicts runs={runs} say={(v) => chatVerdict(headline(v.results))} />
      <ChartSlot><AnswerTimeline runs={runs} /></ChartSlot>
    </Scenario>
  );
}

// --- 多人同時 ---------------------------------------------------------------

/**
 * Total generation at 1 / 2 / 4 streams, with each run's ideal -- N times
 * its own single-stream decode -- dashed beside it, so the gap between what
 * it did and what perfect sharing would give is the reading.
 */
function CrowdChart({ runs: all }: { runs: RunView[] }) {
  // The lines are the runs staying; one folding away just leaves its line.
  // Memoised on the runs, which the page keeps stable: data rebuilt on every
  // render would replay the lines' animation each time the page polls.
  const runs = useMemo(() => activeRuns(all), [all]);
  const data = useMemo(() => {
    const streams = [...new Set(runs.flatMap((v) => streamRows(v.results).map((s) => s.streams)))].sort((a, b) => a - b);
    return streams.map((n) => {
      const row: Record<string, string | number | undefined> = { x: `${n} 路` };
      for (const v of runs) {
        const rows = streamRows(v.results);
        const s = rows.find((r) => r.streams === n);
        const one = rows.find((r) => r.streams === 1);
        row[`a${v.key}`] = s?.total;
        row[`i${v.key}`] = one ? one.decode * n : undefined;
      }
      return row;
    });
  }, [runs]);
  if (data.length < 2) return null;
  const axis = niceAxis(data.flatMap((row) => runs.flatMap((v) => [row[`a${v.key}`], row[`i${v.key}`]] as (number | undefined)[])));
  const last = data.length - 1;
  return (
    <div>
      <ResponsiveContainer width="100%" height={CHART_H} debounce={250}>
        <LineChart data={data} margin={{ top: 14, right: 40, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={LINE.faint} vertical={false} />
          <XAxis dataKey="x" stroke={LINE.soft} tick={{ ...AXIS_TICK, fill: 'rgba(255,255,255,0.65)' }} tickLine={false} height={22} />
          <YAxis stroke={LINE.soft} tick={AXIS_TICK} tickLine={false} width={40}
                 domain={[0, axis.ticks[axis.ticks.length - 1]]} ticks={axis.ticks} tickFormatter={axis.label} />
          <ChartTooltip
            cursor={{ stroke: LINE.strong, strokeWidth: 1 }}
            content={({ active, label, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as Record<string, number | undefined>;
              return tooltipBox(`${label}・總吞吐`, runs.map((v) => ({
                key: v.key, colour: colour(v.mark),
                value: row[`a${v.key}`] !== undefined ? `${fmtTps(row[`a${v.key}`])} tok/s` : '—',
                label: `${runs.length > 1 ? `${RUN_MARKS[v.mark]?.letter} ` : ''}理想 ${fmtTps(row[`i${v.key}`])}`,
              })));
            }}
          />
          {runs.map((v) => (
            <Line key={`i${v.key}`} dataKey={`i${v.key}`} stroke={colour(v.mark)} strokeOpacity={0.5}
                  strokeDasharray="4 4" strokeWidth={1.5} dot={false} activeDot={false}
                  {...LINE_MOTION} connectNulls />
          ))}
          {runs.map((v) => (
            <Line key={`a${v.key}`} dataKey={`a${v.key}`} stroke={colour(v.mark)} strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round"
                  dot={{ r: 4, fill: colour(v.mark), stroke: SURFACE.card, strokeWidth: 2 }}
                  activeDot={{ r: 5, fill: colour(v.mark), stroke: SURFACE.card, strokeWidth: 2 }}
                  {...LINE_MOTION} connectNulls>
              {/* The endpoint only, and only for one run: several runs' endpoints
                  collide, and their figures are in the lines above. */}
              <LabelList dataKey={`a${v.key}`} content={(p) => {
                const { x, y, value, index } = p as { x?: number; y?: number; value?: number; index?: number };
                if (runs.length > 1 || index !== last || value === undefined || x === undefined || y === undefined) return null;
                return (
                  <text x={Number(x) + 8} y={Number(y) + 4} fill="rgba(255,255,255,0.85)" fontSize={11} fontFamily={MONO}>
                    {fmtTps(value)}
                  </text>
                );
              }} />
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="rgba(255,255,255,0.75)" strokeWidth="2" /></svg>
          <Text type="secondary" style={{ fontSize: 11 }}>實際總吞吐 tok/s</Text>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeDasharray="4 4" /></svg>
          <Text type="secondary" style={{ fontSize: 11 }}>理想：N × 單人速度</Text>
        </span>
      </div>
    </div>
  );
}

function CrowdCard({ runs }: { runs: RunView[] }) {
  const any = runs.some((v) => topStreams(v.results));
  return (
    <Scenario title="多人同時" question="幾個人同時用，會不會互相拖慢？">
      {!any ? <Empty text="這次沒有量多路。" /> : (
        <>
          <Headlines runs={runs} figures={(v) => {
            const top = topStreams(v.results);
            if (!top) return [{ value: '', unit: '', label: '沒有量多路' }];
            return [
              { value: fmtTps(top.total), unit: 'tok/s', label: `${top.streams} 路總吞吐` },
              { value: fmtTps(top.decode), unit: 'tok/s', label: '每路 Decode' },
              { value: fmtTimes(top.speedup), unit: '', label: 'Speedup' },
            ];
          }} />
          <Verdicts runs={runs} say={(v) => crowdVerdict(v.results)} />
          <ChartSlot><CrowdChart runs={runs} /></ChartSlot>
        </>
      )}
    </Scenario>
  );
}

// --- 長文 -------------------------------------------------------------------

function Empty({ text }: { text: string }) {
  return (
    <div style={{
      flex: 1, minHeight: CHART_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', padding: '0 16px',
    }}>
      <Text type="secondary" style={{ fontSize: 13, lineHeight: 1.7 }}>{text}</Text>
    </div>
  );
}

/** Decode against context depth, one line per run that measured more than
 *  one depth; the first-token wait at each depth is said in words under it
 *  rather than on a second axis. */
function LongChart({ runs: all }: { runs: RunView[] }) {
  const runs = useMemo(() => activeRuns(all), [all]);
  const deep = useMemo(() => runs.filter((v) => depthRows(v.results).length > 1), [runs]);
  const data = useMemo(() => DEPTH_TESTS
    .filter((d) => deep.some((v) => find(v.results, d.id)))
    .map((d) => {
      const row: Record<string, string | number | undefined> = { x: d.short };
      for (const v of deep) row[`d${v.key}`] = find(v.results, d.id)?.gen_tps;
      return row;
    }), [deep]);
  const axis = niceAxis(data.flatMap((row) => deep.map((v) => row[`d${v.key}`] as number | undefined)));
  const last = data.length - 1;
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 11 }}>Decode tok/s，依上下文長度</Text>
      <ResponsiveContainer width="100%" height={CHART_H - 30} debounce={250}>
        <LineChart data={data} margin={{ top: 14, right: 40, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={LINE.faint} vertical={false} />
          <XAxis dataKey="x" stroke={LINE.soft} tick={{ ...AXIS_TICK, fill: 'rgba(255,255,255,0.65)' }} tickLine={false} height={22} />
          <YAxis stroke={LINE.soft} tick={AXIS_TICK} tickLine={false} width={40}
                 domain={[0, axis.ticks[axis.ticks.length - 1]]} ticks={axis.ticks} tickFormatter={axis.label} />
          <ChartTooltip
            cursor={{ stroke: LINE.strong, strokeWidth: 1 }}
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
              <LabelList dataKey={`d${v.key}`} content={(p) => {
                const { x, y, value, index } = p as { x?: number; y?: number; value?: number; index?: number };
                if (runs.length > 1 || index !== last || value === undefined || x === undefined || y === undefined) return null;
                return (
                  <text x={Number(x) + 8} y={Number(y) + 4} fill="rgba(255,255,255,0.85)" fontSize={11} fontFamily={MONO}>
                    {fmtTps(value)}
                  </text>
                );
              }} />
            </Line>
          ))}
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
        {deep.map((v) => (
          <Text key={v.key} type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
            {runs.length > 1 ? `${RUN_MARKS[v.mark]?.letter}  ` : ''}TTFT {depthRows(v.results)
              .map((d) => `${d.short} ${secs(d.r.ttft_ms / 1000)} 秒`).join(' → ')}
          </Text>
        ))}
      </div>
    </div>
  );
}

const QUICK_ONLY = '快速檔只測 1k。用完整檔跑一次，才看得到上下文變長後慢多少。';

function LongCard({ runs }: { runs: RunView[] }) {
  const any = runs.some((v) => depthRows(v.results).length > 1);
  return (
    <Scenario title="長文" question="貼進很長的文件、或對話拉得很長時，會慢多少？">
      {!any ? <Empty text={QUICK_ONLY} /> : (
        <>
          <Headlines runs={runs} figures={(v) => {
            const rows = depthRows(v.results);
            const deep = rows[rows.length - 1];
            if (!deep || rows.length < 2) return [{ value: '', unit: '', label: '只測 1k' }];
            return [
              { value: fmtTps(deep.r.gen_tps), unit: 'tok/s', label: `${deep.short} Decode` },
              { value: secs(deep.r.ttft_ms / 1000), unit: '秒', label: `${deep.short} TTFT` },
            ];
          }} />
          <Verdicts runs={runs} say={(v) => longVerdict(v.results) ?? '快速檔只測 1k，沒有長文的數字。'} />
          <ChartSlot><LongChart runs={runs} /></ChartSlot>
        </>
      )}
    </Scenario>
  );
}

// --- 內容類型 ---------------------------------------------------------------

/** Decode per content type as horizontal bars: a row per content, a bar
 *  per run inside it, every bar on one scale; the acceptance rate beside
 *  the content's name when the engine reports it. */
function ContentChart({ runs }: { runs: RunView[] }) {
  const active = activeRuns(runs);
  const kinds = CONTENT_TESTS.filter((c) => active.some((v) => find(v.results, c.id)));
  const top = scaleTop(kinds.flatMap((c) => active.map((v) => find(v.results, c.id)?.gen_tps)));
  const many = comparing(runs);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {kinds.map((c) => {
        const accepts = active.map((v) => find(v.results, c.id)?.accept_rate)
          .filter((a): a is number => a != null);
        return (
          <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr)', gap: 8, alignItems: 'center' }}>
            <div style={{ lineHeight: 1.3 }}>
              <Text style={{ fontSize: 12 }}>{c.label}</Text>
              {accepts.length > 0 && (
                <Text type="secondary" style={{ fontSize: 10, fontFamily: MONO, display: 'block', whiteSpace: 'nowrap' }}>
                  接受 {accepts.map((a) => `${Math.round(a * 100)}%`).join('／')}
                </Text>
              )}
            </div>
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

function ContentCard({ runs }: { runs: RunView[] }) {
  const any = runs.some((v) => contentRows(v.results).length > 0);
  return (
    <Scenario title="內容類型" question="中文、英文、程式碼，哪一種生成最快？">
      {!any ? <Empty text="這次沒有量內容類型。" /> : (
        <>
          <Headlines runs={runs} figures={(v) => {
            const rows = contentRows(v.results);
            if (!rows.length) return [{ value: '', unit: '', label: '沒有量' }];
            const zh = rows.find((c) => c.id === 'content-zh');
            const fastest = rows.reduce((a, b) => (b.r.gen_tps > a.r.gen_tps ? b : a));
            return [
              { value: fmtTps(zh?.r.gen_tps), unit: 'tok/s', label: '中文' },
              { value: fmtTps(fastest.r.gen_tps), unit: 'tok/s', label: `最快：${fastest.label}` },
            ];
          }} />
          <Verdicts runs={runs} say={(v) => contentVerdict(v.results)} />
          <ChartSlot><ContentChart runs={runs} /></ChartSlot>
        </>
      )}
    </Scenario>
  );
}

/**
 * 成績單: one card per situation that matters -- one person chatting,
 * several at once, a long context, the kind of text -- each answering its
 * question with a figure, a sentence and one chart that actually varies.
 * The tables with every number are below, folded away.
 */
export default function BenchReport({ runs, copyable = true }: { runs: RunView[]; copyable?: boolean }) {
  const { message } = AntApp.useApp();
  const [ref, width] = useWidth();
  const columns = width >= 660 ? 2 : 1;
  const copy = async () => {
    const text = markdown(activeRuns(runs), (m) => RUN_MARKS[m]?.letter ?? '?');
    if (await copyText(text)) message.success('已複製成 Markdown');
    else message.error('瀏覽器不讓複製，請改用匯出');
  };
  return (
    <Card
      size="small"
      title={comparing(runs) ? '成績單・比較' : '成績單'}
      style={{ height: '100%' }}
      extra={copyable && runs.length > 0 && (
        <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()}>複製成文字</Button>
      )}
    >
      <div ref={ref} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <RunHeader runs={runs} />
        <div style={{
          display: 'grid', gap: 12, alignItems: 'stretch',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}>
          <ChatCard runs={runs} />
          <CrowdCard runs={runs} />
          <LongCard runs={runs} />
          <ContentCard runs={runs} />
        </div>
      </div>
    </Card>
  );
}
