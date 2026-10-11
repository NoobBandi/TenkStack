import { Table, Typography } from 'antd';
import type { TableColumnsType as ColumnsType } from 'antd';
import { ACCENT, MONO } from '../../theme';
import { RunMark } from './BenchResults';
import type { RunView } from './metrics';

const { Text } = Typography;

const num: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

/** Which way a figure improves: decode rises, a wait falls. */
export type Better = 'higher' | 'lower';

/**
 * A figure of a block's table: its heading, how to read it off a row of one
 * run, how to write it, and which way is better -- which decides the bold
 * and the colour of a comparison.
 */
export interface Measure<R> {
  key: string;
  title: React.ReactNode;
  value: (r: R) => number | undefined;
  text: (v: number) => string;
  better: Better;
}

/** A row of a block's table, and how to find it in one run. */
export interface TableLine<R> {
  key: string;
  label: React.ReactNode;
  pick: (run: RunView) => R | undefined;
}

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

/**
 * One cell: the figure; comparing, the best of the runs in bold, and on
 * every run after A how far it is from A. The percentage is coloured only
 * when it is better, and its sign is always written, so the colour never
 * carries the reading alone.
 */
function Figure({ values, index, measure }: { values: (number | undefined)[]; index: number; measure: Pick<Measure<unknown>, 'text' | 'better'> }) {
  const v = values[index];
  if (!finite(v)) return <Text type="secondary">—</Text>;
  const known = values.filter(finite);
  const best = measure.better === 'higher' ? Math.max(...known) : Math.min(...known);
  const isBest = known.length > 1 && v === best;
  const base = values[0];
  let diff: React.ReactNode = null;
  if (index > 0 && finite(base) && base !== 0) {
    const pct = (v / base - 1) * 100;
    if (Math.abs(pct) >= 0.5) {
      const better = measure.better === 'higher' ? pct > 0 : pct < 0;
      diff = (
        <span style={{ fontSize: 11, marginInlineStart: 6, color: better ? ACCENT.ok : 'rgba(255,255,255,0.45)' }}>
          {pct > 0 ? '+' : ''}{Math.round(pct)}%
        </span>
      );
    }
  }
  return (
    <span style={num}>
      <span style={{ fontWeight: isBest ? 600 : 400 }}>{measure.text(v)}</span>
      {diff}
    </span>
  );
}

/**
 * A block's numbers: a row per test, a column per figure -- and comparing,
 * under each figure a column per run, headed by its letter, so A and B sit
 * side by side where they are compared.
 */
export function CompareTable<R>({ runs, lines, measures, labelTitle }: {
  runs: RunView[];
  lines: TableLine<R>[];
  measures: Measure<R>[];
  labelTitle: React.ReactNode;
}) {
  const shown = runs.filter((v) => !v.leaving);
  const many = shown.length > 1;
  const cell = (m: Measure<R>, line: TableLine<R>, i: number) => {
    const values = shown.map((run) => {
      const r = line.pick(run);
      return r === undefined ? undefined : m.value(r);
    });
    return <Figure values={values} index={i} measure={m} />;
  };
  const columns: ColumnsType<TableLine<R>> = [
    { key: 'label', title: labelTitle, render: (_, line) => line.label, width: 120 },
    ...measures.map((m) => (many
      ? {
        key: m.key, title: m.title,
        children: shown.map((run, i) => ({
          key: `${m.key}-${run.key}`, title: <RunMark index={run.mark} />, align: 'right' as const,
          render: (_: unknown, line: TableLine<R>) => cell(m, line, i),
        })),
      }
      : {
        key: m.key, title: m.title, align: 'right' as const,
        render: (_: unknown, line: TableLine<R>) => cell(m, line, 0),
      })),
  ];
  return (
    <Table<TableLine<R>>
      size="small" pagination={false} rowKey="key" bordered={many}
      dataSource={lines} columns={columns} scroll={{ x: 'max-content' }}
    />
  );
}

/**
 * The same, turned: a row per figure and a column per run, for a block that
 * measures one condition (one person at 1k) with several figures.
 */
export type RowMeasure<R> = Omit<Measure<R>, 'title'> & { label: React.ReactNode };

export function FigureTable<R>({ runs, measures, pick }: {
  runs: RunView[];
  measures: RowMeasure<R>[];
  pick: (run: RunView) => R | undefined;
}) {
  const shown = runs.filter((v) => !v.leaving);
  const many = shown.length > 1;
  type Row = RowMeasure<R>;
  const columns: ColumnsType<Row> = [
    { key: 'label', title: '項目', render: (_, m) => m.label },
    ...shown.map((run, i) => ({
      key: run.key, title: many ? <RunMark index={run.mark} /> : '數值', align: 'right' as const,
      render: (_: unknown, m: Row) => {
        const values = shown.map((v) => {
          const r = pick(v);
          return r === undefined ? undefined : m.value(r);
        });
        return <Figure values={values} index={i} measure={m} />;
      },
    })),
  ];
  return (
    <Table<Row>
      size="small" pagination={false} rowKey="key" bordered={many}
      dataSource={measures} columns={columns} scroll={{ x: 'max-content' }}
    />
  );
}
