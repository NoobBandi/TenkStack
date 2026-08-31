import { useEffect, useMemo, useState } from 'react';
import { Select, Typography } from 'antd';
import {
  CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip,
  XAxis, YAxis, ZAxis,
} from 'recharts';
import { fetchActivity, type ActivityRow, type ModelInfo } from '../api';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * Generation speed against how deep into the window each request started.
 *
 * This is the chart the long sessions ask for. Speed inside one request barely
 * moves -- 4,881 tokens over ten minutes drifted 7.75 to 7.67 -- so a curve per
 * request is a flat line. What falls is speed *between* requests as the
 * conversation grows, and that is what this draws.
 *
 * Two things it took a look at the data to get right:
 *
 * One model at a time. The store holds every model this box has ever served,
 * and their medians run from 9 t/s to 128. Pooled, the bins are not a decay
 * curve at all -- they rise and fall with whichever model happened to be
 * loaded at that depth, which reads as "it speeds up at 50K" and is nonsense.
 *
 * A median line over the raw points, not a line through them. Each dot is an
 * independent request; several land at the same depth with different rates, so
 * connecting them in depth order would zigzag and would imply a trajectory
 * through depth that nothing actually travelled. The dots are the evidence and
 * stay visible; the line is the claim, and it is an aggregate.
 */
const CHART_H = 148;
const BIN = 8192;
/** A bin drawn from one or two requests is noise, and a line anchored to it
 *  wanders. Below this the bin still shows its dots, just no line vertex. */
const MIN_PER_BIN = 3;

interface Bin { depth: number; median: number; n: number }

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export default function DepthCurve({
  models, ctxSize,
}: { models: ModelInfo[]; ctxSize?: number | null }) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>();

  // Default to whatever is loaded: the question is nearly always about the
  // model in front of you, and a picker that starts empty makes the reader
  // choose before the block says anything.
  const running = models.find((m) => m.running)?.id;
  const model = chosen ?? running;

  useEffect(() => {
    if (!model) return;
    // Capped rather than unbounded. Rates move when the engine underneath them
    // does -- a llama.cpp upgrade shifted this box 51% at long context -- and a
    // window reaching back past such a change draws two eras as one curve.
    const load = () => fetchActivity(250, model)
      .then((r) => { setRows(r); setFailed(false); })
      .catch(() => setFailed(true));
    load();
    // A row appears only when a request finishes, so polling faster than this
    // would redraw the same points.
    const timer = window.setInterval(load, 20000);
    return () => window.clearInterval(timer);
  }, [model]);

  const bins = useMemo<Bin[]>(() => {
    const buckets = new Map<number, number[]>();
    for (const r of rows) {
      const key = Math.floor(r.depth / BIN);
      const list = buckets.get(key);
      if (list) list.push(r.tokens_per_second);
      else buckets.set(key, [r.tokens_per_second]);
    }
    return [...buckets.entries()]
      .filter(([, v]) => v.length >= MIN_PER_BIN)
      .map(([k, v]) => ({ depth: k * BIN + BIN / 2, median: median(v), n: v.length }))
      .sort((a, b) => a.depth - b.depth);
  }, [rows]);

  const picker = (
    <Select
      size="small"
      value={model} onChange={setChosen}
      style={{ minWidth: 150, maxWidth: 220 }}
      popupMatchSelectWidth={240}
      options={models.map((m) => ({
        value: m.id,
        label: <span style={{ fontFamily: MONO, fontSize: 11 }}>{m.name || m.id}</span>,
      }))}
    />
  );

  if (!model || failed || rows.length === 0) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {models.length > 0 && picker}
        </div>
        <div style={{
          height: CHART_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ fontSize: 11, opacity: 0.35, fontFamily: MONO }}>
            {failed ? '讀不到 llama-swap 的活動紀錄'
              : !model ? '沒有模型' : '這個模型尚無完成的請求'}
          </Text>
        </div>
      </div>
    );
  }

  const limit = ctxSize ?? Math.max(...rows.map((r) => r.depth)) * 1.1;
  const newest = rows[0];
  const deep = bins.filter((b) => b.depth / limit > 0.6);
  const shallow = bins.filter((b) => b.depth / limit < 0.2);
  // Stated rather than left to be eyeballed off the line: the ratio is the
  // whole point of the chart, and the axis alone makes the reader compute it.
  const falloff = deep.length && shallow.length
    ? median(shallow.map((b) => b.median)) / median(deep.map((b) => b.median))
    : null;

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 6, flexWrap: 'wrap',
      }}>
        <div>
          <Text style={{ fontSize: 22, lineHeight: 1 }}>
            {newest.tokens_per_second.toFixed(1)}
          </Text>
          <Text style={{ fontSize: 10, opacity: 0.45, marginInlineStart: 4 }}>tok/s 最近</Text>
        </div>
        <Text style={{ fontSize: 11, opacity: 0.5, fontFamily: MONO }}>
          在 {(newest.depth / 1024).toFixed(0)}K
          {falloff && falloff > 1.05 ? ` ・ 深處慢 ${falloff.toFixed(1)}×` : ''}
        </Text>
        <div style={{ marginInlineStart: 'auto' }}>{picker}</div>
      </div>

      <ResponsiveContainer width="100%" height={CHART_H}>
        <ComposedChart margin={{ top: 4, right: 10, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={LINE.faint} vertical={false} />
          <XAxis
            dataKey="depth" type="number"
            domain={[0, ctxSize ?? 'dataMax']}
            stroke={LINE.soft}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
            tickFormatter={(v: number) => `${Math.round(v / 1024)}K`}
            tickLine={false}
            allowDuplicatedCategory={false}
          />
          <YAxis
            type="number" domain={[0, 'auto']}
            stroke={LINE.soft}
            tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 10, fontFamily: MONO }}
            tickFormatter={(v: number) => v.toFixed(0)}
            tickLine={false}
            width={44}
          />
          <ZAxis range={[16, 16]} />
          <Tooltip
            cursor={{ stroke: LINE.strong, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as Partial<ActivityRow & Bin> | undefined;
              if (!active || !p || p.depth === undefined) return null;
              const isBin = p.median !== undefined;
              return (
                <div style={{
                  background: '#141414', border: `1px solid ${LINE.soft}`,
                  borderRadius: 4, fontSize: 11, fontFamily: MONO, padding: '6px 9px',
                }}>
                  <div style={{ opacity: 0.45, marginBottom: 3 }}>
                    深度 {Math.round(p.depth / 1024)}K
                  </div>
                  {isBin ? (
                    <>
                      <div>中位 {p.median!.toFixed(2)} tok/s</div>
                      <div style={{ opacity: 0.6 }}>{p.n} 次請求</div>
                    </>
                  ) : (
                    <>
                      <div>{(p.tokens_per_second ?? 0).toFixed(2)} tok/s</div>
                      <div style={{ opacity: 0.6 }}>輸出 {(p.output ?? 0).toLocaleString()}</div>
                    </>
                  )}
                </div>
              );
            }}
          />
          {/* Evidence under the claim: every request as a faint dot, so the
              spread the median sits in stays visible. */}
          <Scatter
            data={rows} dataKey="tokens_per_second"
            fill="rgba(255,255,255,0.22)" shape="circle" isAnimationActive={false}
          />
          <Line
            data={bins} dataKey="median" type="monotone"
            stroke="rgba(255,255,255,0.85)" strokeWidth={1.75}
            dot={false} isAnimationActive={false}
            activeDot={{ r: 4, fill: '#141414', stroke: 'rgba(255,255,255,0.85)', strokeWidth: 2 }}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <Text style={{
        fontSize: 10, opacity: 0.38, fontFamily: MONO, display: 'block', marginTop: 6,
      }}>
        線為每 8K 深度的中位數 ・ 點為單次請求 ・ 最近 {rows.length} 次
        {ctxSize ? ` ・ 視窗 ${Math.round(ctxSize / 1024)}K` : ''}
      </Text>
    </div>
  );
}
