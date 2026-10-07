import { Card, Tooltip, Typography } from 'antd';
import type { BenchCaseResult } from '../../api';
import { LINE, MONO } from '../../theme';
import { BarLine } from './Bars';
import { ColTitle, InfoTip, RunMark } from './BenchResults';
import { RUN_MARKS, TERMS, fmtMs, fmtPromptTps, fmtTps } from './labels';
import {
  CONTENT_TESTS, DEPTH_TESTS, STREAM_TESTS, find, fmtTimes, sameMeasurement, scaleTop, streamRows,
  testName, tpot, type RunView,
} from './metrics';
import { Row } from './motion';

const { Text } = Typography;

/** The tests as the table's rows, in three groups. */
interface Group { key: string; en: string; zh: string; tip: string; rows: RowSpec[] }
interface RowSpec { id: string; label: string; sub?: string; same?: string }

const GROUPS: Group[] = [
  {
    key: 'depth', en: 'Single request', zh: '單一請求 × 上下文長度', tip: TERMS.depth,
    rows: DEPTH_TESTS.map((t) => ({ id: t.id, label: `${t.short} 上下文`, sub: testName(t.pp) })),
  },
  {
    key: 'streams', en: 'Concurrency', zh: '多人同時', tip: TERMS.streams,
    rows: STREAM_TESTS.map((t) => ({
      id: t.id, label: t.streams === 1 ? '1 人' : `${t.streams} 人同時`, sub: '各 1k 上下文',
      same: t.streams === 1 ? 'depth-1k' : undefined,
    })),
  },
  {
    key: 'content', en: 'Content', zh: '內容類型', tip: TERMS.content,
    rows: CONTENT_TESTS.map((t) => ({
      id: t.id, label: t.label, sub: '1k 上下文',
      same: t.id === 'content-en' ? 'depth-1k' : undefined,
    })),
  },
];

/** What a cell needs about one run's case. */
interface Cell { r: BenchCaseResult; run: RunView }

interface Metric {
  key: string;
  title: React.ReactNode;
  value: (c: Cell) => number | undefined;
  text: (v: number) => string;
  /** Where the value means nothing for the row -- Total for one request --
   *  the cell is left empty rather than dashed. */
  applies?: (id: string) => boolean;
  /** A reference on the bar's track. */
  tick?: (c: Cell) => number | undefined;
  tip: (c: Cell, v: number) => string;
  /** A scale's top fixed by the measure, not the data: a percentage. */
  top?: number;
}

const total = (c: Cell) => streamRows(c.run.results).find((s) => s.id === c.r.case_id);
const ideal = (c: Cell) => {
  const rows = streamRows(c.run.results);
  const one = rows.find((s) => s.streams === 1);
  const self = rows.find((s) => s.id === c.r.case_id);
  return one && self ? one.decode * self.streams : undefined;
};

const METRICS: Metric[] = [
  {
    key: 'ttft', title: <ColTitle en="TTFT" unit="ms" zh="首字延遲・越短越好" tip={TERMS.ttft} />,
    value: (c) => c.r.ttft_ms, text: fmtMs,
    tip: (_, v) => `TTFT ${fmtMs(v)} ms，約 ${(v / 1000).toFixed(1)} 秒`,
  },
  {
    key: 'prefill', title: <ColTitle en="Prefill" unit="tok/s" zh="讀入提示" tip={TERMS.prefill} />,
    value: (c) => c.r.prompt_tps, text: fmtPromptTps,
    tip: (_, v) => `Prefill ${fmtPromptTps(v)} tok/s`,
  },
  {
    key: 'decode', title: <ColTitle en="Decode" unit="tok/s" zh="生成速度" tip={TERMS.decode} />,
    value: (c) => c.r.gen_tps, text: fmtTps,
    tip: (c, v) => [
      `Decode ${fmtTps(v)} tok/s，每 token ${fmtTps(tpot(c.r))} ms`,
      c.r.samples >= 2 ? `${c.r.samples} 次平均，標準差 ±${fmtTps(c.r.gen_tps_stdev)}` : '只跑 1 次',
      c.r.ignore_eos ? `輸出 ${Math.round(c.r.output_tokens)} token`
        : `輸出 ${Math.round(c.r.output_tokens)} token（引擎不支援 ignore_eos，改用寫長文的題目）`,
    ].join('；'),
  },
  {
    key: 'total', title: <ColTitle en="Total" unit="tok/s" zh="多人總吞吐" tip={TERMS.total} />,
    applies: (id) => id.startsWith('conc-') && id !== 'conc-1',
    value: (c) => total(c)?.total, text: fmtTps, tick: ideal,
    tip: (c, v) => `Total ${fmtTps(v)} tok/s，理想 ${fmtTps(ideal(c))}（Speedup ${fmtTimes(total(c)?.speedup)}）`,
  },
  {
    key: 'accept', title: <ColTitle en="Accept" zh="推測接受率" tip={TERMS.accept} />,
    value: (c) => (c.r.accept_rate == null ? undefined : c.r.accept_rate * 100),
    text: (v) => `${Math.round(v)}%`, top: 100,
    tip: (_, v) => `接受率 ${Math.round(v)}%`,
  },
];

/** The legend: whose bar is which, by letter and colour. */
function Legend({ runs }: { runs: RunView[] }) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
      {runs.map((v) => (
        <Row key={v.key} leaving={v.leaving}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <RunMark index={v.mark} />
            <Text style={{ fontSize: 12 }}>{v.name}</Text>
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>{v.when}</Text>
          </span>
        </Row>
      ))}
    </div>
  );
}

const cellPad = '7px 12px';

/**
 * Performance: every figure of every test in one table, oMLX's arrangement,
 * with each value drawn as a bar on its column's scale. Comparing, each
 * cell holds a bar per run, so A and B are read against each other where
 * they sit instead of across column groups.
 */
export default function BenchPerformance({ runs }: { runs: RunView[] }) {
  const active = runs.filter((v) => !v.leaving);
  const comparing = active.length > 1;
  const has = (id: string) => active.some((v) => find(v.results, id));
  const groups = GROUPS
    .map((g) => ({ ...g, rows: g.rows.filter((r) => has(r.id)) }))
    .filter((g) => g.rows.length);
  const metrics = METRICS.filter((m) => m.key !== 'accept'
    || active.some((v) => (v.results ?? []).some((r) => r.accept_rate != null)));
  const quickOnly = DEPTH_TESTS.every((d) => d.id === 'depth-1k' || !has(d.id));

  // One scale per column, over the runs staying: a run folding away does not
  // hold the others' bars short while it goes.
  const tops = Object.fromEntries(metrics.map((m) => {
    if (m.top) return [m.key, m.top];
    const values = groups.flatMap((g) => g.rows.flatMap((row) => active.flatMap((run) => {
      if (m.applies && !m.applies(row.id)) return [];
      const r = find(run.results, row.id);
      if (!r) return [];
      return [m.value({ r, run }), m.tick?.({ r, run })];
    })));
    return [m.key, scaleTop(values)];
  }));

  const columns = `minmax(128px, 150px) repeat(${metrics.length}, minmax(150px, 1fr))`;
  const minWidth = 150 + metrics.length * 160;

  return (
    <Card
      size="small"
      title={<span>Performance <Text type="secondary" style={{ fontWeight: 400 }}>（效能總表）</Text></span>}
      extra={<Text type="secondary" style={{ fontSize: 12 }}>每一欄共用一把尺，條越長數字越大</Text>}
    >
      {comparing && <Legend runs={runs} />}
      <div style={{ overflowX: 'auto' }}>
        <div role="table" style={{ display: 'grid', gridTemplateColumns: columns, minWidth }}>
          <div role="row" style={{ display: 'contents' }}>
            <div role="columnheader" style={{ padding: cellPad, fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${LINE.soft}` }}>
              <ColTitle en="Test" zh="測試" />
            </div>
            {metrics.map((m) => (
              <div key={m.key} role="columnheader" style={{
                padding: cellPad, fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${LINE.soft}`,
              }}>
                {m.title}
              </div>
            ))}
          </div>

          {groups.map((g) => (
            <div key={g.key} role="rowgroup" style={{ display: 'contents' }}>
              <div role="row" style={{
                gridColumn: '1 / -1', padding: '12px 12px 4px', display: 'flex', alignItems: 'baseline', gap: 8,
              }}>
                <Text style={{ fontSize: 12, fontWeight: 600 }}>{g.en}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{g.zh}</Text>
                <InfoTip tip={g.tip} />
                {g.key === 'depth' && quickOnly && (
                  <Text type="secondary" style={{ fontSize: 11, marginInlineStart: 'auto' }}>
                    快速檔只量 1k，完整檔才有 8k–128k
                    <InfoTip tip={TERMS.tier} />
                  </Text>
                )}
              </div>
              {g.rows.map((row) => {
                const same = row.same && active.some((run) =>
                  sameMeasurement(find(run.results, row.id), find(run.results, row.same!)));
                return (
                  <div key={row.id} role="row" className="bn-perf-row" style={{ display: 'contents' }}>
                    <div role="rowheader" style={{ padding: cellPad, borderTop: `1px solid ${LINE.faint}` }}>
                      <div style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{row.label}</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        {row.sub && <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>{row.sub}</Text>}
                        {same && (
                          <Tooltip title="和「1k 上下文」是同一次量測：後端只量一次、在三個地方回報，所以數字相同。">
                            <Text type="secondary" style={{
                              fontSize: 11, cursor: 'help', borderBottom: `1px dotted ${LINE.medium}`,
                            }}>
                              同 1k
                            </Text>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                    {metrics.map((m) => (
                      <div key={m.key} role="cell" style={{
                        padding: cellPad, borderTop: `1px solid ${LINE.faint}`,
                        display: 'flex', flexDirection: 'column', justifyContent: 'center',
                      }}>
                        {(!m.applies || m.applies(row.id)) && runs.map((run) => {
                          const r = find(run.results, row.id);
                          const v = r ? m.value({ r, run }) : undefined;
                          const label = comparing ? `${RUN_MARKS[run.mark]?.letter}・${run.name}：` : '';
                          return (
                            <BarLine
                              key={run.key} run={run} comparing={comparing} top={tops[m.key]}
                              value={v} text={v !== undefined ? m.text(v) : ''}
                              tick={r && m.tick ? m.tick({ r, run }) : undefined}
                              tip={r && v !== undefined ? label + m.tip({ r, run }, v) : undefined}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
