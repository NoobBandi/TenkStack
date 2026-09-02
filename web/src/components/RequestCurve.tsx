import { useEffect, useMemo, useState } from 'react';
import { Typography } from 'antd';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { RequestTrace } from '../stream';
import { PANEL_HEADER_H, REQUEST_CHART_H, TRACE_LIST_ROWS_H } from './panelHeight';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * One request, start to finish, as tokens against time.
 *
 * The y axis is cumulative tokens rather than tokens/sec on purpose. A request
 * has two phases whose rates differ by more than thirty times -- prefill runs
 * around 300 t/s, generation around 8 -- and drawing both on one rate axis
 * flattens generation onto the floor. Two axes would be worse: the crossing
 * point of two scales is decided by the scales, not by the data.
 *
 * Cumulative tokens is one measure both phases contribute to, so the whole
 * request is a single honest line. Speed becomes slope: the steep opening is
 * prefill, the long shallow run is generation, and the corner between them is
 * time-to-first-token. The rate itself is a single current value, so it is a
 * number beside the chart rather than a second series inside it.
 */
const CHART_H = REQUEST_CHART_H;

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** One line per recent request: what it produced, how fast, how long.
 *
 *  The chart answers "how is this one going" -- a shape, with prefill's steep
 *  opening and generation's shallow run visible as slope. It cannot answer "how
 *  have the last few gone", which is the other question anyone actually has,
 *  and which a coding agent raises constantly because one turn is a dozen
 *  requests. Rows rather than a second chart: these are a handful of finished
 *  totals, and totals are a column of numbers, not a plot.
 *
 *  Clicking one draws it, so the list is also how you get back to the request
 *  that just scrolled past. */
/** Past this, a request that has not reported since is not running -- it was
 *  already under way when the page connected and finished unseen, or its slot
 *  stopped answering. Either way its ticks are not coming. */
const STALE_MS = 90 * 1000;



function TraceList({ traces, current, onPick }: {
  traces: RequestTrace[];
  current?: string;
  onPick: (key: string | null) => void;
}) {
  // Staleness is a function of the clock, and nothing else here re-renders once
  // the ticks stop -- which is exactly the case it has to detect. Without this
  // the row that has gone quiet keeps its live dot until something unrelated
  // redraws the page.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    // A fixed height, scrolling past four rows. The list grows from nothing to
    // six as requests arrive, and this card sits in a stretch row -- so every
    // arrival was making the card taller and dragging the depth chart beside it
    // along with it, which is a layout that moves while you are reading it.
    // Four rows is what the chart's own height affords without the card
    // outgrowing its neighbour.
    <div style={{
      marginTop: 10, borderTop: `1px solid ${LINE.faint}`, paddingTop: 6,
      height: TRACE_LIST_ROWS_H, overflowY: 'auto', overflowX: 'hidden',
    }}>
      {traces.length === 0 && (
        <Text style={{
          fontSize: 10, fontFamily: MONO, opacity: 0.25, paddingInlineStart: 6,
        }}>
          尚無請求
        </Text>
      )}
      {traces.map((t) => {
        const points = t.points;
        const seconds = points.length
          ? (points[points.length - 1].at - points[0].at) / 1000
          : 0;
        const tokens = points.length ? points[points.length - 1].tokens : 0;
        // Its own average, not the last instantaneous reading: this row is a
        // summary and the sampled rate at the end of a request says nothing
        // about the whole of it.
        const rate = seconds > 0 ? tokens / seconds : 0;
        const active = t.key === current;
        // `done` only arrives if the release line was seen. A request already
        // running when the console connected reports one tick and then nothing
        // -- its release happened before anyone was listening -- and stayed on
        // the list with a live dot and 0.0 t/s indefinitely.
        const stale = !t.done && now - t.updatedAt > STALE_MS;
        return (
          <div
            key={t.key}
            onClick={() => onPick(active ? null : t.key)}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer',
              padding: '3px 6px', borderRadius: 3, fontFamily: MONO, fontSize: 11,
              background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto',
              background: t.done || stale ? LINE.strong : ACCENT.ok,
              boxShadow: t.done || stale ? 'none' : `0 0 6px ${ACCENT.ok}b3`,
              opacity: stale ? 0.5 : 1,
            }} />
            <span style={{ opacity: 0.75, minWidth: 62, textAlign: 'right' }}>
              {fmt(tokens)} tok
            </span>
            <span style={{ opacity: 0.75, minWidth: 62, textAlign: 'right' }}>
              {rate.toFixed(1)} t/s
            </span>
            <span style={{ opacity: 0.5, minWidth: 46, textAlign: 'right' }}>
              {seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)}s
            </span>
            <span style={{ opacity: 0.3, marginInlineStart: 'auto' }}>
              slot {t.slot}
              {t.truncated ? ' ・ 截斷' : ''}
              {!t.done && !stale ? ' ・ 進行中' : ''}
              {stale ? ' ・ 未回報' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function RequestCurve({ traces }: { traces: RequestTrace[] }) {
  // Which request the chart is drawing, when it is not simply the newest. Held
  // by key rather than by index: the list is rebuilt on every tick and an index
  // would slide onto a different request as older ones fall off the end.
  const [pinned, setPinned] = useState<string | null>(null);

  const recent = useMemo(
    () => traces.slice().sort((a, b) => b.updatedAt - a.updatedAt),
    [traces],
  );

  // The live one if anything is running, else the most recent -- a finished
  // request is still the answer to "what did that just do". A pinned one wins
  // over both, and is dropped once it ages out of the window.
  const live = recent.find((t) => !t.done);
  const chosen = pinned ? recent.find((t) => t.key === pinned) : undefined;
  const trace = chosen ?? live ?? recent[0];

  useEffect(() => {
    if (pinned && !recent.some((t) => t.key === pinned)) setPinned(null);
  }, [pinned, recent]);

  if (!trace || trace.points.length < 2) {
    return (
      /* A column, not a row. This was a centred flex when it held only the
         message; dropping the list into it put the rows beside the text
         instead of under it. */
      <div>
        {/* The same header height as the charted branch, empty. Without it the
            card is one line shorter whenever nothing is running, which is the
            same jump this fixed-height list exists to stop. */}
        <div style={{ height: PANEL_HEADER_H }} />
        <div style={{
          height: CHART_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ fontSize: 11, opacity: 0.35, fontFamily: MONO }}>
            {trace ? '請求太短，沒有足夠的取樣點' : '目前沒有請求'}
          </Text>
        </div>
        <TraceList traces={recent} current={trace?.key} onPick={setPinned} />
      </div>
    );
  }

  const t0 = trace.points[0].at;
  const data = trace.points.map((p) => ({
    at: (p.at - t0) / 1000,
    tokens: p.tokens,
    rate: p.rate,
    phase: p.phase,
  }));

  // Where prefill handed over. Undefined when the prompt was small enough that
  // llama-server never printed a prefill tick for it.
  const firstDecode = data.find((d) => d.phase === 'decode');
  const lastPrefill = [...data].reverse().find((d) => d.phase === 'prefill');
  const ttft = lastPrefill && firstDecode ? firstDecode.at : undefined;

  const last = data[data.length - 1];
  const elapsed = last.at;

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 14,
        marginBottom: 8, flexWrap: 'wrap',
      }}>
        {/* The rate is one current value, which is a number's job, not a
            chart's. Proportional figures: this is a headline, not a column. */}
        <div>
          <Text style={{ fontSize: 22, lineHeight: 1 }}>{last.rate.toFixed(1)}</Text>
          <Text style={{ fontSize: 10, opacity: 0.45, marginInlineStart: 4 }}>tok/s</Text>
        </div>
        <Text style={{ fontSize: 11, opacity: 0.5, fontFamily: MONO }}>
          {fmt(last.tokens)} tokens ・ {elapsed.toFixed(0)}s
          {ttft !== undefined ? ` ・ TTFT ${ttft.toFixed(1)}s` : ''}
        </Text>
        {chosen && live && chosen.key !== live.key && (
          // Without this, a pinned request looks exactly like the live one, and
          // a chart frozen on something that finished a minute ago reads as a
          // request that has stalled.
          <Text
            onClick={() => setPinned(null)}
            style={{
              fontSize: 10, fontFamily: MONO, cursor: 'pointer',
              color: ACCENT.ok, opacity: 0.8,
            }}
          >
            已釘選 ・ 回到進行中
          </Text>
        )}
        <Text style={{ fontSize: 11, opacity: 0.35, fontFamily: MONO, marginInlineStart: 'auto' }}>
          slot {trace.slot} ・ task {trace.task}
          {trace.done ? (trace.truncated ? ' ・ 已截斷' : ' ・ 完成') : ' ・ 進行中'}
        </Text>
      </div>

      <ResponsiveContainer width="100%" height={CHART_H}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={LINE.faint} vertical={false} />
          <XAxis
            dataKey="at" type="number" domain={[0, 'dataMax']}
            stroke={LINE.soft}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
            tickFormatter={(v: number) => `${v.toFixed(0)}s`}
            tickLine={false}
          />
          <YAxis
            stroke={LINE.soft}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
            tickFormatter={fmt}
            tickLine={false}
            width={44}
          />
          {ttft !== undefined && (
            // Chrome, not data: a hairline marking where the slope changes, so
            // the corner is unambiguous without a second series.
            <ReferenceLine
              x={ttft} stroke={LINE.strong} strokeWidth={1}
              label={{
                value: 'TTFT', position: 'insideTopLeft',
                fill: 'rgba(255,255,255,0.45)', fontSize: 9, fontFamily: MONO,
              }}
            />
          )}
          {/* A custom body rather than a formatter, matching GpuChart: the
              phase and the rate both live on the datum, and rendering them
              here keeps them side by side instead of as two stacked rows. */}
          <Tooltip
            cursor={{ stroke: LINE.strong, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as typeof data[number] | undefined;
              if (!active || !point) return null;
              return (
                <div style={{
                  background: '#141414', border: `1px solid ${LINE.soft}`,
                  borderRadius: 4, fontSize: 11, fontFamily: MONO, padding: '6px 9px',
                }}>
                  <div style={{ opacity: 0.45, marginBottom: 3 }}>
                    {point.at.toFixed(1)}s ・ {point.phase === 'prefill' ? '讀取提示' : '產生'}
                  </div>
                  <div>{point.tokens.toLocaleString()} tokens</div>
                  <div style={{ opacity: 0.6 }}>{point.rate.toFixed(1)} tok/s</div>
                </div>
              );
            }}
          />
          <Line
            type="monotone" dataKey="tokens"
            stroke="rgba(255,255,255,0.75)" strokeWidth={1.5}
            dot={false} isAnimationActive={false}
            activeDot={{ r: 4, fill: '#141414', stroke: 'rgba(255,255,255,0.75)', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>

      <TraceList traces={recent} current={trace.key} onPick={setPinned} />
    </div>
  );
}
