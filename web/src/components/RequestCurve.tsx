import { Typography } from 'antd';
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { RequestTrace } from '../stream';
import { LINE, MONO } from '../theme';

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
const CHART_H = 132;

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

export default function RequestCurve({ traces }: { traces: RequestTrace[] }) {
  // The live one if anything is running, else the most recent -- a finished
  // request is still the answer to "what did that just do".
  const live = traces.filter((t) => !t.done).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const trace = live ?? traces.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];

  if (!trace || trace.points.length < 2) {
    return (
      <div style={{
        height: CHART_H + 40, display: 'flex', alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Text style={{ fontSize: 11, opacity: 0.35, fontFamily: MONO }}>
          {trace ? '請求太短，沒有足夠的取樣點' : '目前沒有請求'}
        </Text>
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
    </div>
  );
}
