import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Empty, Segmented, Space, Typography } from 'antd';
import {
  Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { fetchGpuHistory, type GpuPoint, type GpuSample } from '../api';
import { DEVICE_SERIES, LINE, MONO, SERIES } from '../theme';
import {
  maxCeiling, powerCeiling, tempCeiling, vramAxisMax, vramAxisTicks,
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

const METRICS = [
  { label: '功耗', value: 'power', unit: 'W', axis: (v: number) => `${v.toFixed(0)}` },
  { label: '顯存', value: 'vram', unit: 'GiB', axis: (v: number) => `${(v / 1024).toFixed(0)}G` },
  { label: '溫度', value: 'temp', unit: '°C', axis: (v: number) => `${v.toFixed(0)}` },
] as const;

type Metric = (typeof METRICS)[number]['value'];

/** Dash patterns in the order devices are drawn. Solid reads as "the first
 *  one", which on a single-card machine is the only one. */
const DASHES = ['0', '4 3', '1 3', '6 3 1 3'];

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
  const [metric, setMetric] = useState<Metric>('power');
  const [series, setSeries] = useState<Record<string, GpuPoint[]>>({});
  const [loading, setLoading] = useState(true);

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

  const multi = indices.length > 1;
  const active = METRICS.find((m) => m.value === metric) ?? METRICS[0];

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
  const activeMax = active.value === 'vram' ? vramMax
    : active.value === 'power' ? powerMax : tempMax;

  const stats = useMemo(() => {
    if (!rows.length || !indices.length) return null;
    const first = indices[0];
    const powers = rows.map((r) => r[`power${first}`] ?? 0);
    const vrams = rows.map((r) => r[`vram${first}`] ?? 0);
    return {
      peakPower: Math.max(...powers),
      avgPower: powers.reduce((a, b) => a + b, 0) / powers.length,
      peakVram: Math.max(...vrams),
    };
  }, [rows, indices]);

  const legend = multi
    ? indices.map((i, n) => {
      const colour = DEVICE_SERIES[n % DEVICE_SERIES.length];
      return {
        name: `xpu:${i}`,
        style: n === 0
          ? { height: 2, background: colour }
          : { height: 0, borderTop: `2px dashed ${colour}` },
      };
    })
    : [
      { name: '顯存', style: { height: 6, background: `${SERIES.vram}55` } },
      { name: '功耗', style: { height: 2, background: SERIES.power } },
      { name: '溫度', style: { height: 0, borderTop: `2px dashed ${SERIES.temp}` } },
    ];

  return (
    <Card
      size="small"
      title={
        <Space size={12} wrap>
          <span style={{ fontFamily: MONO, letterSpacing: 0.8, fontSize: 12 }}>
            GPU{multi ? ` ×${indices.length}` : ''}
          </span>
          {stats && !multi && (
            <Text style={{ fontSize: 11, opacity: 0.5, fontFamily: MONO }}>
              PEAK {stats.peakPower.toFixed(0)}W ・ AVG {stats.avgPower.toFixed(0)}W ・
              VRAM {(stats.peakVram / 1024).toFixed(1)}G
            </Text>
          )}
          {multi && (
            <Segmented
              size="small"
              value={metric}
              onChange={(v) => setMetric(v as Metric)}
              options={METRICS.map((m) => ({ label: m.label, value: m.value }))}
            />
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
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={rows} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="vramFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES.vram} stopOpacity={0.28} />
                <stop offset="100%" stopColor={SERIES.vram} stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke={LINE.faint} vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={clock}
              stroke={LINE.soft}
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
              minTickGap={56}
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
              tickFormatter={multi ? active.axis : (v: number) => `${(v / 1024).toFixed(0)}G`}
              domain={multi ? [0, activeMax] : [0, vramMax]}
              ticks={multi && active.value !== 'vram' ? undefined : vramTicks}
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
            <Tooltip
              contentStyle={{
                background: '#141414', border: `1px solid ${LINE.soft}`,
                borderRadius: 4, fontSize: 11, fontFamily: MONO,
              }}
              labelFormatter={(label) => (typeof label === 'number' ? clock(label) : String(label))}
              formatter={(value, name) => {
                if (typeof value !== 'number') return [String(value), name];
                if (multi) {
                  return [
                    active.value === 'vram'
                      ? `${(value / 1024).toFixed(2)} GiB`
                      : `${value.toFixed(0)} ${active.unit}`,
                    name,
                  ];
                }
                if (name === '顯存') return [`${(value / 1024).toFixed(2)} GiB`, name];
                if (name === '功耗') return [`${value.toFixed(0)} W`, name];
                return [`${value.toFixed(0)} °C`, name];
              }}
            />

            {multi ? (
              indices.map((i, n) => (
                <Line
                  key={i}
                  yAxisId="vram" type="monotone"
                  dataKey={`${metric}${i}`} name={`xpu:${i}`}
                  stroke={DEVICE_SERIES[n % DEVICE_SERIES.length]}
                  strokeWidth={1.25}
                  strokeDasharray={DASHES[n % DASHES.length]}
                  dot={false} isAnimationActive={false}
                  connectNulls
                />
              ))
            ) : (
              <>
                {/* Filled area for the slow-moving quantity, hairlines for the
                    fast ones: shape distinguishes the series, not colour. */}
                <Area
                  yAxisId="vram" type="monotone" dataKey={`vram${indices[0]}`} name="顯存"
                  stroke={SERIES.vram} strokeWidth={1.5}
                  fill="url(#vramFill)" isAnimationActive={false} dot={false}
                />
                <Line
                  yAxisId="power" type="monotone" dataKey={`power${indices[0]}`} name="功耗"
                  stroke={SERIES.power} strokeWidth={1.25} dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="temp" type="monotone" dataKey={`temp${indices[0]}`} name="溫度"
                  stroke={SERIES.temp} strokeWidth={1.25} strokeDasharray="3 3"
                  dot={false} isAnimationActive={false}
                />
              </>
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}

      <Space size={16} style={{ marginTop: 8 }} wrap>
        {legend.map((s) => (
          <Space key={s.name} size={6}>
            <span style={{ display: 'inline-block', width: 16, ...s.style }} />
            <Text style={{ fontSize: 10, opacity: 0.5, fontFamily: MONO }}>{s.name}</Text>
          </Space>
        ))}
      </Space>
    </Card>
  );
}
