import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Card, Empty, Segmented, Select, Space, Typography } from 'antd';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
  type MouseHandlerDataParam,
} from 'recharts';
import { fetchGpuHistory, type GpuPoint, type GpuSample } from '../api';
import { LINE, MONO, SERIES } from '../theme';
import {
  deviceTag, maxCeiling, powerCeiling, tempCeiling, vramAxisMax, vramAxisTicks,
} from '../hardware';

const { Text } = Typography;

/**
 * GPU history.
 *
 * With one card the three quantities are drawn together: a filled area for
 * VRAM, hairlines for power and temperature, each on its own fixed axis. That
 * does not survive a second card -- six series on one axis is a thicket -- so
 * from two cards on, one quantity is chosen and each card gets a line.
 *
 * Colour separates the series, with dash patterns kept as a second cue so they
 * remain readable where hue does not carry.
 */

const WINDOWS = [
  { label: '5 分', value: 300 },
  { label: '15 分', value: 900 },
  { label: '1 時', value: 3600 },
  { label: '2 時', value: 7200 },
];



/**
 * Plot geometry, needed because the highlight below works out which trace the
 * cursor is nearest and recharts does not hand out its own layout.
 *
 * The XAxis height is pinned rather than left at its default so these three
 * numbers fully describe the drawing area: change one and the hit-testing
 * follows, instead of drifting silently out of step.
 */
const CHART_H = 240;
const PLOT_TOP = 6;
const AXIS_H = 24;
const PLOT_H = CHART_H - PLOT_TOP - AXIS_H;

/** How close the cursor must come, as a fraction of plot height, before a trace
 *  is picked up. Without a limit the nearest trace is always "hovered", and the
 *  chart flickers between series as the pointer crosses empty space. */
const REACH = 0.12;

/**
 * One drawn series.
 *
 * Three of them, one card at a time. The highlight needs a single answer to
 * "what is drawn, in what colour, against which ceiling" -- the ceiling being
 * what turns a reading into a height on screen -- so the legend, the paths and
 * the hit-testing all read from this one list.
 */
interface Trace {
  key: string;
  name: string;
  colour: string;
  axis: 'vram' | 'power' | 'temp';
  /** Top of this trace's own axis; value / max is its height in the plot. */
  max: number;
  dash?: string;
  /** VRAM is filled even at rest; the hairlines only fill when highlighted. */
  filled?: boolean;
  /** How this trace's reading is written out in the tooltip, units included. */
  format: (v: number) => string;
}

interface Props {
  /** Live samples for every device, appended so the trace keeps moving
   *  between refetches. */
  latest: GpuSample[];
}

interface Row {
  t: number;
  [key: string]: number | undefined;
}

function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString('zh-TW', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export default function GpuChart({ latest }: Props) {
  const [seconds, setSeconds] = useState(900);
  // Which card is plotted. Null until the first listing arrives, then the
  // lowest index -- device 0, which is the one serving the language models.
  const [device, setDevice] = useState<string | null>(null);
  const [series, setSeries] = useState<Record<string, GpuPoint[]>>({});
  const [loading, setLoading] = useState(true);
  /** dataKey of the trace under the cursor, or null. */
  const [hover, setHover] = useState<string | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  // Gradient ids have to be unique per instance: they are document-wide, and
  // two charts on one page sharing an id would both take the first one's fill.
  const gid = useId().replace(/:/g, '');

  const load = useCallback(async (window: number) => {
    try {
      const data = await fetchGpuHistory(window);
      setSeries(data.devices);
    } catch {
      // Leave whatever is on screen rather than blanking the chart.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setLoading(true); void load(seconds); }, [seconds, load]);

  // The backend has been sampling since it started, so the window is already
  // full on arrival. Refetching occasionally keeps the far edge honest without
  // pulling the whole series on every tick.
  useEffect(() => {
    const timer = window.setInterval(() => void load(seconds), 30000);
    return () => window.clearInterval(timer);
  }, [seconds, load]);

  useEffect(() => {
    if (!latest.length) return;
    setSeries((prev) => {
      const next = { ...prev };
      const now = Date.now() / 1000;
      const cutoff = now - seconds;
      for (const s of latest) {
        const key = String(s.index);
        const point: GpuPoint = {
          t: now,
          power: s.power_w,
          vram: s.memory_used_mib,
          freq: s.frequency_mhz,
          temp: s.temperature_c,
          util: s.memory_util_percent,
        };
        next[key] = [...(prev[key] ?? []).filter((p) => p.t >= cutoff), point];
      }
      return next;
    });
  }, [latest, seconds]);

  const indices = useMemo(
    () => Object.keys(series).sort((a, b) => Number(a) - Number(b)),
    [series],
  );

  /**
   * One row per sample tick, every device flattened into it.
   *
   * Devices are aligned by position, not by timestamp: the poller appends one
   * sample per device per tick and decimates them identically, so the arrays
   * run in lockstep. Matching on the timestamps themselves would fail, because
   * the readings within a tick are taken a few milliseconds apart.
   */
  const rows = useMemo<Row[]>(() => {
    if (!indices.length) return [];
    const length = Math.max(...indices.map((i) => series[i].length));
    const out: Row[] = [];
    for (let k = 0; k < length; k += 1) {
      const row: Row = { t: series[indices[0]][k]?.t ?? 0 };
      for (const i of indices) {
        const p = series[i][k];
        row[`power${i}`] = p?.power ?? undefined;
        row[`vram${i}`] = p?.vram ?? undefined;
        row[`temp${i}`] = p?.temp ?? undefined;
      }
      out.push(row);
    }
    return out;
  }, [series, indices]);

  // The selected card, falling back to the first while nothing is chosen and
  // if the chosen one disappears -- a driver unloading should not blank the
  // chart.
  const plotted = device && indices.includes(device) ? device : indices[0];

  /**
   * The VRAM axis runs 0 to the card's capacity and stays there.
   *
   * Taken from the largest card present, so a pair of unequal cards share one
   * scale and the smaller one visibly cannot reach the top -- which is the true
   * statement about where a model will fit.
   */
  const vramTotal = useMemo(
    () => Math.max(0, ...latest.map((g) => g.memory_total_mib ?? 0)),
    [latest],
  );
  const vramMax = vramAxisMax(vramTotal);
  const vramTicks = useMemo(() => vramAxisTicks(vramMax), [vramMax]);
  // Ceilings come from the cards themselves; the widest wins so unequal cards
  // stay comparable on one axis.
  const powerMax = maxCeiling(latest, powerCeiling);
  const tempMax = maxCeiling(latest, tempCeiling);

  const stats = useMemo(() => {
    if (!rows.length || !plotted) return null;
    const powers = rows.map((r) => r[`power${plotted}`] ?? 0);
    const vrams = rows.map((r) => r[`vram${plotted}`] ?? 0);
    return {
      peakPower: Math.max(...powers),
      avgPower: powers.reduce((a, b) => a + b, 0) / powers.length,
      peakVram: Math.max(...vrams),
    };
  }, [rows, plotted]);

  /**
   * One card's three quantities, always.
   *
   * There used to be a second shape: with more than one GPU the chart switched
   * to one quantity across every device, chosen from a row of buttons. It
   * answered a question nobody was asking -- two cards doing unrelated work do
   * not get compared watt for watt -- and it cost the thing the chart is for,
   * which is seeing power, memory and temperature move together on one card.
   * Picking the card from a list restores that and removes the branch.
   */
  const traces = useMemo<Trace[]>(() => {
    if (!plotted) return [];
    return [
      { key: `vram${plotted}`, name: '顯存', colour: SERIES.vram, axis: 'vram', max: vramMax,
        filled: true, format: (v) => `${(v / 1024).toFixed(2)} GiB` },
      { key: `power${plotted}`, name: '功耗', colour: SERIES.power, axis: 'power', max: powerMax,
        format: (v) => `${v.toFixed(0)} W` },
      { key: `temp${plotted}`, name: '溫度', colour: SERIES.temp, axis: 'temp', max: tempMax,
        dash: '3 3', format: (v) => `${v.toFixed(0)} °C` },
    ];
  }, [plotted, vramMax, powerMax, tempMax]);

  const byKey = useMemo(() => new Map(traces.map((t) => [t.key, t])), [traces]);

  /**
   * Pick the trace nearest the pointer.
   *
   * Hovering the path itself is the obvious implementation and a poor one: a
   * 1.25px hairline is close to unhittable, and a trace that only lights up
   * when you land on it exactly reads as broken rather than as precise. So the
   * cursor's height in the plot is compared against every trace's height at the
   * column it is over, and the closest within REACH wins -- being near the line
   * is enough.
   *
   * Comparing value/max rather than pixels is what lets three traces on three
   * different axes be measured against each other at all: each axis runs 0 to
   * its own ceiling over the same plot height, so the fractions are already in
   * the same units the eye is using.
   */
  // Round minutes across the window, about six of them.
  const now = Date.now() / 1000;
  const ticks = useMemo(() => {
    const step = [60, 120, 180, 300, 600, 900, 1200, 1800, 3600].find((s) => seconds / s <= 7) ?? 3600;
    const out: number[] = [];
    for (let t = Math.ceil((now - seconds) / step) * step; t <= now; t += step) out.push(t);
    return out;
    // Recomputed as the window moves on, a step at a time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, Math.floor(now / 60)]);

  const handleMove = useCallback((state: MouseHandlerDataParam, e: { clientY?: number }) => {
    // Typed `number | TooltipIndex | undefined`, and TooltipIndex is a *string*
    // -- recharts hands the index over as "17", not 17. A `typeof === 'number'`
    // guard here silently rejected every event.
    // (Number(null) is 0, so the empty case has to be caught before the cast or
    // it would read as "hovering the first sample".)
    const raw = state.activeTooltipIndex;
    const idx = raw === null || raw === undefined ? NaN : Number(raw);
    const box = plotRef.current?.getBoundingClientRect();
    const row = Number.isFinite(idx) ? rows[idx] : undefined;
    if (!row || !box || typeof e?.clientY !== 'number') { setHover(null); return; }

    const frac = (PLOT_H - (e.clientY - box.top - PLOT_TOP)) / PLOT_H;
    let best: string | null = null;
    let gap = REACH;
    for (const t of traces) {
      const v = row[t.key];
      if (typeof v !== 'number' || !t.max) continue;
      const d = Math.abs(v / t.max - frac);
      if (d < gap) { gap = d; best = t.key; }
    }
    setHover(best);
  }, [rows, traces]);

  const clearHover = useCallback(() => setHover(null), []);

  return (
    <Card
      size="small"
      title={
        <Space size={12} wrap>
          <span style={{ fontFamily: MONO, letterSpacing: 0.8, fontSize: 12 }}>GPU</span>
          {/* A list, not a row of buttons. Buttons are right for the time
              window -- four fixed choices, all worth seeing at once -- and
              wrong for the cards, which are named rather than ordered and
              whose count is a property of the machine. */}
          {indices.length > 1 && (
            <Select
              size="small"
              value={plotted}
              onChange={setDevice}
              style={{ minWidth: 168 }}
              options={indices.map((i) => {
                const card = latest.find((g) => String(g.index) === i);
                return {
                  value: i,
                  label: (
                    <span style={{ fontFamily: MONO, fontSize: 11 }}>
                      {deviceTag(card?.vendor, Number(i))}
                      <span style={{ opacity: 0.45, marginLeft: 6 }}>
                        {card?.name ?? ''}
                      </span>
                    </span>
                  ),
                };
              })}
            />
          )}
          {stats && (
            <Text style={{ fontSize: 11, opacity: 0.5, fontFamily: MONO }}>
              PEAK {stats.peakPower.toFixed(0)}W ・ AVG {stats.avgPower.toFixed(0)}W ・
              VRAM {(stats.peakVram / 1024).toFixed(1)}G
            </Text>
          )}
        </Space>
      }
      extra={
        <Segmented
          size="small"
          value={seconds}
          onChange={(v) => setSeconds(v as number)}
          options={WINDOWS}
        />
      }
    >
      {rows.length < 2 ? (
        <div style={{ height: 240, display: 'grid', placeItems: 'center' }}>
          <Empty
            description={loading ? '讀取中…' : '尚無資料'}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        </div>
      ) : (
        <div ref={plotRef}>
          {/* Redrawn once a resize settles: folding the sidebar resizes the page every frame. */}
          <ResponsiveContainer width="100%" height={CHART_H} debounce={250}>
            <AreaChart
              data={rows}
              margin={{ top: PLOT_TOP, right: 4, left: 0, bottom: 0 }}
              onMouseMove={handleMove}
              onMouseLeave={clearHover}
            >
              {/* One gradient per trace, all reaching zero at the baseline: the
                  fill is there to give the line a body that fades out, not to
                  shade an area, so it must not read as a second quantity. */}
              <defs>
                {traces.map((t) => (
                  <linearGradient key={t.key} id={`${gid}-${t.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={t.colour} stopOpacity={0.38} />
                    <stop offset="100%" stopColor={t.colour} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>

              <CartesianGrid stroke={LINE.faint} vertical={false} />
              {/* The window chosen, not the span of the data: fitted to the
                  data, a history of three minutes filled the width the same
                  under 5 分 as under 2 時, and the four choices looked alike. */}
              <XAxis
                dataKey="t"
                type="number"
                domain={[now - seconds, now]}
                allowDataOverflow
                ticks={ticks}
                tickFormatter={clock}
                stroke={LINE.soft}
                tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
                minTickGap={56}
                height={AXIS_H}
              />
              {/* Fixed domains, never fitted to the data.
               *
               * An axis that rescales makes a quiet hour and a full card look
               * identical -- the trace fills the panel either way and only the
               * numbers down the side, which move, say otherwise. Pinned to the
               * card's capacity, height alone carries the reading.
               *
               * Each quantity also gets its own axis rather than sharing one.
               * Watts and degrees on a single scale would let whichever carried
               * the larger numbers set the range, leaving the other flat along
               * the bottom. */}
              <YAxis
                yAxisId="vram"
                stroke={LINE.soft}
                tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
                tickFormatter={(v: number) => `${(v / 1024).toFixed(0)}G`}
                domain={[0, vramMax]}
                ticks={vramTicks}
                allowDataOverflow
                width={44}
              />
              {/* Parked on the right even though they are hidden: an unplaced
                  axis defaults to the left, where these two silently took the
                  space the visible VRAM scale needed and pushed it out of the
                  panel entirely. */}
              <YAxis yAxisId="power" orientation="right" domain={[0, powerMax]}
                     allowDataOverflow hide />
              <YAxis yAxisId="temp" orientation="right" domain={[0, tempMax]}
                     allowDataOverflow hide />
              {/* Written out rather than left to `formatter`, because the
                  tooltip has to narrow to the highlighted trace and recharts
                  gives no way to drop rows from the default one -- a formatter
                  can only restyle the rows it is handed.

                  Narrowing is the point: once a trace is picked out, three
                  readings answer a question that was asked about one of them.
                  With nothing highlighted all of them are still listed, which
                  is what the tooltip is for at rest. */}
              <Tooltip
                content={({ active: on, label, payload }) => {
                  if (!on || !payload?.length) return null;
                  const shown = hover
                    ? payload.filter((p) => p.dataKey === hover)
                    : payload;
                  if (!plotted.length) return null;
                  return (
                    <div style={{
                      background: '#141414', border: `1px solid ${LINE.soft}`,
                      borderRadius: 4, fontSize: 11, fontFamily: MONO,
                      padding: '6px 9px', minWidth: 132,
                    }}>
                      <div style={{ opacity: 0.45, marginBottom: 4 }}>
                        {typeof label === 'number' ? clock(label) : ''}
                      </div>
                      {shown.map((p) => {
                        const t = byKey.get(String(p.dataKey));
                        return (
                          <div
                            key={String(p.dataKey)}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: 1.7 }}
                          >
                            <span style={{
                              width: 7, height: 7, borderRadius: '50%',
                              background: t?.colour ?? String(p.color), flex: 'none',
                            }} />
                            <span style={{ opacity: 0.6 }}>{t?.name ?? String(p.name)}</span>
                            <span style={{ marginLeft: 'auto' }}>
                              {t && typeof p.value === 'number' ? t.format(p.value) : String(p.value)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                }}
              />

              {/* Every trace is an Area, including the ones that read as
                  hairlines: the fill is what the highlight turns on, and a Line
                  has none to turn on. At rest the unfilled ones are drawn exactly
                  as before. */}
              {traces.map((t) => {
                const lit = hover === t.key;
                const dim = hover !== null && !lit;
                return (
                  <Area
                    key={t.key}
                    yAxisId={t.axis} type="monotone"
                    dataKey={t.key} name={t.name}
                    stroke={t.colour}
                    strokeWidth={lit ? 2.4 : t.filled ? 1.5 : 1.25}
                    strokeDasharray={t.dash}
                    strokeOpacity={dim ? 0.22 : 1}
                    fill={`url(#${gid}-${t.key})`}
                    fillOpacity={lit ? 1 : t.filled ? (dim ? 0.18 : 0.72) : 0}
                    // A marker on every trace at once is three answers to a
                    // question with one subject. It belongs to whichever trace
                    // is highlighted, and there is only ever one of those.
                    //
                    // Hollow rather than solid: filled in the trace's own colour
                    // it sat on a line of that same colour and read as a slight
                    // thickening. Punched out against the panel it is a ring
                    // with a hole in it, which nothing else on the chart is.
                    dot={false}
                    activeDot={lit && { r: 4, fill: '#141414', stroke: t.colour, strokeWidth: 2 }}
                    isAnimationActive={false}
                    connectNulls={false}
                  />
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* The legend highlights too. Reaching for a name is easier than finding
          a trace, and it is the only way to light up a series that is currently
          flat against the floor with the others. */}
      <Space size={16} style={{ marginTop: 8 }} wrap>
        {traces.map((t) => {
          const lit = hover === t.key;
          return (
            <Space
              key={t.key} size={6}
              style={{ cursor: 'default', opacity: hover !== null && !lit ? 0.35 : 1 }}
              onMouseEnter={() => setHover(t.key)}
              onMouseLeave={clearHover}
            >
              <span
                style={{
                  display: 'inline-block', width: 16,
                  ...(t.dash && t.dash !== '0'
                    ? { height: 0, borderTop: `2px dashed ${t.colour}` }
                    : { height: t.filled ? 6 : 2, background: t.filled ? `${t.colour}55` : t.colour }),
                }}
              />
              <Text style={{ fontSize: 10, opacity: lit ? 0.9 : 0.5, fontFamily: MONO }}>
                {t.name}
              </Text>
            </Space>
          );
        })}
      </Space>
    </Card>
  );
}
