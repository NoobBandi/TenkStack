import { useId } from 'react';
import { Typography } from 'antd';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * One quantity over time, drawn the way the GPU chart draws its traces:
 * a fixed axis, a hairline with a body that fades to the baseline, a faint
 * horizontal grid, clock ticks along the bottom. The GPU chart puts three
 * quantities on one panel and needs a highlight to tell them apart; this is
 * for a row of panels with one quantity each, where the panel's name does
 * that job and the chart can stay plain.
 *
 * The axis is fixed and never fitted to the data, for the same reason as
 * over there: a quiet hour and a busy one must not look alike, so height
 * alone has to carry the reading.
 */

const PLOT_TOP = 6;
const AXIS_H = 22;

interface Props {
  label: string;
  /** Oldest first; a null is a gap in the line, not a zero. */
  points: { t: number; v: number | null }[];
  colour: string;
  /** Top of the axis. */
  max: number;
  ticks?: number[];
  /** A tick's label along the side. */
  axis: (v: number) => string;
  /** A reading written out in full, for the tooltip and the live figure. */
  format: (v: number) => string;
  /** Under the live figure, when the number alone needs a qualifier. */
  note?: string;
  height?: number;
}

function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString('zh-TW', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export default function MetricChart({
  label, points, colour, max, ticks, axis, format, note, height = 150,
}: Props) {
  // Gradient ids are document-wide; three of these on one page must not
  // share one or they all take the first panel's colour.
  const gid = useId().replace(/:/g, '');
  const last = [...points].reverse().find((p) => p.v !== null)?.v ?? null;

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ fontSize: 10, letterSpacing: 1.2, opacity: 0.45 }}>{label}</Text>
        <Text style={{ fontSize: 13, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
          {last !== null ? format(last) : '—'}
        </Text>
      </div>
      {/* Always rendered, even when empty, so a row of panels keeps one
          baseline whether or not each has something to add. */}
      <Text style={{ fontSize: 10, opacity: 0.4, display: 'block', textAlign: 'right', minHeight: 15 }}>
        {note ?? ' '}
      </Text>

      {points.length < 2 ? (
        <div style={{ height, display: 'grid', placeItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 11 }}>尚無資料</Text>
        </div>
      ) : (
        // Redrawn once a resize settles: folding the sidebar resizes the page every frame.
        <ResponsiveContainer width="100%" height={height} debounce={250}>
          <AreaChart data={points} margin={{ top: PLOT_TOP, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colour} stopOpacity={0.38} />
                <stop offset="100%" stopColor={colour} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={LINE.faint} vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={clock}
              stroke={LINE.soft}
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
              minTickGap={48}
              height={AXIS_H}
            />
            <YAxis
              stroke={LINE.soft}
              tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
              tickFormatter={axis}
              domain={[0, max]}
              ticks={ticks}
              allowDataOverflow
              width={38}
            />
            <Tooltip
              content={({ active, label: at, payload }) => {
                if (!active || !payload?.length) return null;
                const v = payload[0]?.value;
                return (
                  <div style={{
                    background: '#141414', border: `1px solid ${LINE.soft}`,
                    borderRadius: 4, fontSize: 11, fontFamily: MONO, padding: '6px 9px',
                  }}>
                    <div style={{ opacity: 0.45, marginBottom: 2 }}>
                      {typeof at === 'number' ? clock(at) : ''}
                    </div>
                    <div>{typeof v === 'number' ? format(v) : '—'}</div>
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke={colour}
              strokeWidth={1.5}
              fill={`url(#${gid})`}
              fillOpacity={0.72}
              dot={false}
              activeDot={{ r: 4, fill: '#141414', stroke: colour, strokeWidth: 2 }}
              isAnimationActive={false}
              connectNulls={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
