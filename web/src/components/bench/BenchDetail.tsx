import { useMemo, useState } from 'react';
import { Card, Space, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType as ColumnsType } from 'antd';
import type { BenchRun } from '../../api';
import { useMedia } from '../../media';
import { LINE, MONO } from '../../theme';
import { ColTitle, InfoTip, RunMark } from './BenchResults';
import { TERMS, fmtDuration, fmtWhen, flatten, tierLabel } from './labels';

const { Text } = Typography;

const num: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' };

/** What the common parameters are called, so a newcomer is not left reading
 *  `kv_cache.type_k`. The path stays beside it: it is what the export says. */
const PARAM_LABEL: Record<string, string> = {
  engine: '推論引擎',
  quant: '量化',
  context_length: '上下文長度',
  'kv_cache.type_k': 'KV 快取（K）',
  'kv_cache.type_v': 'KV 快取（V）',
  'kv_cache.unified': '統一 KV 快取',
  'kv_cache.per_slot_context': '每路上下文',
  'kv_cache.host_cache_mib': '主機端快取 MiB',
  'rope.scaling': 'RoPE 縮放',
  'rope.factor': 'RoPE 倍數',
  'rope.original_context': 'RoPE 原始長度',
  'speculative.methods': '推測解碼',
  'speculative.num_tokens': '推測 token 數',
  max_concurrency: '最大並發',
  'batch.batch_size': '批次大小',
  'batch.ubatch_size': '微批次大小',
  'batch.max_batched_tokens': '批次 token 上限',
  'multi_gpu.split_mode': '多卡切分方式',
  'multi_gpu.tensor_split': '多卡切分比例',
  flash_attention: 'Flash Attention',
  online_quantization: '載入時量化',
  gpu_memory_utilization: '顯存比例',
  gpu_layers: 'GPU 層數',
  cpu_moe_layers: 'MoE 放 CPU 層數',
  vision: '視覺',
  'reasoning.enabled': '思考',
  'reasoning.parser': '思考解析器',
  'tools.enabled': '工具呼叫',
  'tools.parser': '工具解析器',
  'sampling.temperature': 'temperature',
  'sampling.top_p': 'top_p',
  'sampling.top_k': 'top_k',
  'sampling.min_p': 'min_p',
  'sampling.repeat_penalty': 'repeat_penalty',
  'sampling.presence_penalty': 'presence_penalty',
};

const runName = (run: BenchRun) => run.name || run.model;
/** Two runs of one model are the usual comparison, so the name alone does
 *  not tell the columns apart; the time does. */
const runTitle = (run: BenchRun) => `${runName(run)}・${fmtWhen(run.started_at)}`;

/** The parameters of one run as dotted paths, with the engine and the
 *  quantisation first: two runs on different engines differ there before
 *  they differ anywhere in the tuning. */
function parameters(run: BenchRun): Record<string, string> {
  const s = run.submission;
  const head: Record<string, string> = {};
  if (s?.engine) head.engine = [s.engine.key, s.engine.version].filter(Boolean).join(' ');
  if (s?.model?.quant) head.quant = s.model.quant;
  return { ...head, ...flatten(s?.tuning ?? {}) };
}

/** A run as a column group's heading: its letter, its name and when. */
function RunTitle({ run, mark }: { run: BenchRun; mark: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
      <RunMark index={mark} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{runTitle(run)}</span>
    </span>
  );
}

/** A section's small heading, with anything that acts on the section at its right. */
function SectionTitle({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
      <Text style={{ fontSize: 12, letterSpacing: 1, opacity: 0.6 }}>{children}</Text>
      {extra && <div style={{ marginInlineStart: 'auto' }}>{extra}</div>}
    </div>
  );
}

/**
 * Parameters and how the run went, in one card: what was launched and what
 * it cost the machine are read together -- a parameter changed between two
 * runs and the VRAM it moved. One run side by side; compared, each part
 * needs a column per run, so one above the other.
 */
export default function BenchDetail({ runs, marks }: { runs: BenchRun[]; marks: number[] }) {
  const wide = useMedia('(min-width: 1100px)');
  const mark = (i: number) => marks[i] ?? i;
  if (!runs.length) return null;
  const single = runs.length === 1;
  return (
    <Card size="small" title={<CardTitle en="Parameters & run" zh="參數與執行" />}>
      <div style={{
        display: 'grid', gap: 24, alignItems: 'start',
        gridTemplateColumns: wide && single ? 'minmax(300px, 0.55fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
      }}>
        <section>
          <SectionTitle>執行與資源</SectionTitle>
          <RunFacts runs={runs} mark={mark} />
        </section>
        <ParameterDiff runs={runs} mark={mark} />
      </div>
    </Card>
  );
}

/** A card's heading: the English name, the Chinese beside it. */
function CardTitle({ en, zh }: { en: string; zh: string }) {
  return <span>{en} <Text type="secondary" style={{ fontWeight: 400 }}>（{zh}）</Text></span>;
}

interface ParamRow { path: string; values: (string | undefined)[]; differs: boolean }

/** The parameters, with only what differs unless asked for everything. */
function ParameterDiff({ runs, mark }: { runs: BenchRun[]; mark: (i: number) => number }) {
  const [showAll, setShowAll] = useState(false);
  const single = runs.length === 1;

  const rows = useMemo<ParamRow[]>(() => {
    const flat = runs.map(parameters);
    const order: string[] = [];
    for (const f of flat) for (const k of Object.keys(f)) if (!order.includes(k)) order.push(k);
    return order.map((path) => {
      const values = flat.map((f) => f[path]);
      return { path, values, differs: new Set(values.map((v) => v ?? '')).size > 1 };
    });
  }, [runs]);

  const differing = rows.filter((r) => r.differs);
  const shown = single || showAll ? rows : differing;
  const sameHash = runs.length > 1 && runs.every((r) => r.tuning_hash && r.tuning_hash === runs[0].tuning_hash);

  const columns: ColumnsType<ParamRow> = [
    {
      title: <ColTitle en="Parameter" zh="參數" />, key: 'path', width: 280,
      render: (_, row) => (
        // The name and its path on one line: stacked, every row was two
        // lines tall and the card ran a screen long.
        <div style={{
          opacity: !single && showAll && !row.differs ? 0.5 : 1,
          display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8,
        }}>
          <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{PARAM_LABEL[row.path] ?? row.path}</span>
          {PARAM_LABEL[row.path] && (
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, whiteSpace: 'nowrap' }}>{row.path}</Text>
          )}
        </div>
      ),
    },
    ...runs.map((run, i) => ({
      key: `v${run.id}`,
      title: single ? <ColTitle en="Value" zh="值" /> : (
        <RunTitle run={run} mark={mark(i)} />
      ),
      render: (_: unknown, row: ParamRow) => {
        const v = row.values[i];
        return (
          <span style={{
            ...num, fontSize: 12, overflowWrap: 'anywhere',
            opacity: !single && showAll && !row.differs ? 0.5 : 1,
          }}>
            {v ?? <Text type="secondary">未設定</Text>}
          </span>
        );
      },
    })),
  ];

  return (
    <section>
      <SectionTitle extra={!single && (
        <Space size={6}>
          <Text type="secondary" style={{ fontSize: 12 }}>顯示全部</Text>
          <Switch size="small" checked={showAll} onChange={setShowAll} />
        </Space>
      )}>
        {single ? '參數' : '參數差異'}
      </SectionTitle>
      {!single && differing.length === 0 ? (
        <Text type="secondary">
          {sameHash ? '參數完全相同。' : '整理過的參數沒有不同。'}
          成績的差別來自其他地方，例如引擎版本、未辨識的旗標或量測誤差。
        </Text>
      ) : (
        <>
          {!single && !showAll && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              {differing.length} 項不同，另有 {rows.length - differing.length} 項相同。
            </Text>
          )}
          <Table<ParamRow>
            size="small" pagination={false} rowKey="path"
            dataSource={shown} columns={columns}
            scroll={{ x: 280 + runs.length * 220 }}
            onRow={(row) => ({
              style: !single && row.differs
                ? { background: 'rgba(255,255,255,0.045)', boxShadow: `inset 2px 0 0 ${LINE.strong}` }
                : undefined,
            })}
          />
        </>
      )}

      <div style={{ marginTop: 16 }}>
        <Text style={{ fontSize: 12, opacity: 0.55 }}>
          未辨識的旗標
          <InfoTip tip="啟動指令裡無法對應到上面欄位的旗標，只列名稱。它們一樣會影響成績，比較時要留意。" />
        </Text>
        {runs.map((run, i) => {
          const flags = run.submission?.unrecognized_flags ?? [];
          return (
            <div key={run.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 6 }}>
              {!single && <RunMark index={mark(i)} />}
              {flags.length === 0 ? <Text type="secondary" style={{ fontSize: 12 }}>沒有</Text> : (
                <Space size={[4, 4]} wrap>
                  {flags.map((f) => <Tag key={f} style={{ fontFamily: MONO, fontSize: 11, marginInlineEnd: 0 }}>{f}</Tag>)}
                </Space>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface FactRow { label: string; tip?: string; values: React.ReactNode[] }

/** How each run went: when, how long, what it took from the machine. */
function RunFacts({ runs, mark }: { runs: BenchRun[]; mark: (i: number) => number }) {
  const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
  const rows: FactRow[] = [
    { label: '檔次', tip: TERMS.tier, values: runs.map((r) => tierLabel(r.tier)) },
    { label: '用時', values: runs.map((r) => fmtDuration(r.duration_s)) },
    {
      label: '冷啟動',
      values: runs.map((r) => (r.submission?.run?.cold_start_s !== undefined
        ? fmtDuration(r.submission.run.cold_start_s) : '已載入')),
    },
    {
      label: '顯存峰值',
      values: runs.map((r) => (r.submission?.resources?.vram_peak_mib ?? []).map(gib).join('、') || '—'),
    },
    {
      label: '主機記憶體峰值',
      values: runs.map((r) => (r.submission?.resources?.ram_peak_mib ? gib(r.submission.resources.ram_peak_mib) : '—')),
    },
    {
      label: '測試組',
      values: runs.map((r) => (r.submission?.suite ? `${r.submission.suite.id} ${r.submission.suite.version}` : '—')),
    },
  ];
  const single = runs.length === 1;
  return (
    <section>
      <Table<FactRow>
        size="small" pagination={false} rowKey="label"
        dataSource={rows}
        scroll={{ x: 140 + runs.length * 180 }}
        columns={[
          { title: <ColTitle en="Item" zh="項目" />, dataIndex: 'label', width: 140,
            render: (v: string, row) => (
              <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{v}{row.tip && <InfoTip tip={row.tip} />}</Text>
            ),
          },
          ...runs.map((run, i) => ({
            key: `f${run.id}`,
            title: single ? <ColTitle en="Value" zh="值" /> : <RunTitle run={run} mark={mark(i)} />,
            render: (_: unknown, row: FactRow) => (
              <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{row.values[i]}</span>
            ),
          })),
        ]}
      />
    </section>
  );
}
