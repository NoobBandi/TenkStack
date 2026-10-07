import { Table, Tooltip, Typography } from 'antd';
import { InfoCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import type { BenchCaseResult } from '../../api';
import { LINE, MONO, SURFACE } from '../../theme';
import { RUN_MARKS, caseHint, caseLabel, fmtMs, fmtPromptTps, fmtTps, sortResults } from './labels';

const { Text } = Typography;

const num: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' };

/**
 * A column heading in English with the Chinese under it.
 *
 * The measurements are named the way the engines and every benchmark write
 * them -- Prefill, Decode, TTFT -- so a number here can be matched against
 * one read anywhere else; the Chinese says what that is. Two lines rather
 * than "Decode (生成) tok/s" on one: on one line the headings outgrew their
 * numbers and wrapped wherever the column happened to end.
 */
export function ColTitle({ en, zh, unit, tip }: {
  en: string; zh: string; unit?: string; tip?: React.ReactNode;
}) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.3 }}>
      <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' }}>
        {en}
        {unit && <span style={{ fontWeight: 400, opacity: 0.55, marginInlineStart: 4 }}>{unit}</span>}
        {tip && <InfoTip tip={tip} />}
      </span>
      <span style={{ whiteSpace: 'nowrap', fontSize: 11, fontWeight: 400, opacity: 0.55 }}>{zh}</span>
    </span>
  );
}

/** What a term means, behind an ⓘ beside it: the glossary lives where the
 *  term is read rather than in a section of its own. */
export function InfoTip({ tip }: { tip: React.ReactNode }) {
  return (
    <Tooltip title={tip} styles={{ root: { maxWidth: 320 } }}>
      <InfoCircleOutlined
        tabIndex={0} aria-label="說明"
        style={{ fontSize: 12, marginInlineStart: 6, opacity: 0.5, cursor: 'help' }}
      />
    </Tooltip>
  );
}

/** The name of a case, with what it means on hover. */
export function CaseName({ id }: { id: string }) {
  const hint = caseHint(id);
  const name = <span style={{ whiteSpace: 'nowrap' }}>{caseLabel(id)}</span>;
  return hint ? <Tooltip title={hint}>{name}</Tooltip> : name;
}

type Row = BenchCaseResult & { pending?: boolean };

/**
 * One run's results, case by case.
 *
 * `running` adds a row for the case in progress, so the table grows in the
 * order the run goes rather than jumping when a row lands.
 */
export function ResultsTable({ results, running }: {
  results: BenchCaseResult[] | null | undefined; running?: string;
}) {
  const rows: Row[] = sortResults(results);
  if (running && !rows.some((r) => r.case_id === running)) {
    rows.push({
      case_id: running, pending: true, ttft_ms: NaN, prompt_tps: NaN, gen_tps: NaN,
      gen_tps_stdev: NaN, samples: 0, output_tokens: NaN, ignore_eos: true,
    });
  }
  const dash = <Text type="secondary">—</Text>;
  const cell = (r: Row, v: React.ReactNode) => (r.pending ? dash : <span style={num}>{v}</span>);

  return (
    <Table<Row>
      size="small"
      rowKey="case_id"
      pagination={false}
      dataSource={rows}
      scroll={{ x: 700 }}
      locale={{ emptyText: '還沒有結果' }}
      columns={[
        {
          title: <ColTitle en="Case" zh="項目" />, dataIndex: 'case_id', width: 100,
          render: (id: string, r) => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CaseName id={id} />
              {r.pending && <LoadingOutlined style={{ fontSize: 12, opacity: 0.6 }} />}
            </span>
          ),
        },
        {
          title: <ColTitle en="TTFT" unit="ms" zh="首字延遲" tip="送出到第一個字出現的時間" />,
          align: 'right', width: 84,
          render: (_, r) => cell(r, fmtMs(r.ttft_ms)),
        },
        {
          title: <ColTitle en="Prefill" unit="tok/s" zh="輸入" tip="讀入提示的速度" />,
          align: 'right', width: 92,
          render: (_, r) => cell(r, fmtPromptTps(r.prompt_tps)),
        },
        {
          title: <ColTitle en="Decode" unit="tok/s" zh="生成" tip="每秒生成幾個 token；多路時是每一路的平均" />,
          align: 'right', width: 92,
          render: (_, r) => (r.pending ? dash : <Text strong style={num}>{fmtTps(r.gen_tps)}</Text>),
        },
        {
          title: <ColTitle en="Total" unit="tok/s" zh="多路總和" tip="多路同時跑時，所有路的 Decode 加總" />,
          align: 'right', width: 88,
          render: (_, r) => (r.pending || r.total_gen_tps === undefined ? dash : cell(r, fmtTps(r.total_gen_tps))),
        },
        {
          title: <ColTitle en="Accept" zh="接受率" tip="推測解碼（MTP、草稿模型）被接受的比例；引擎有提供才有" />,
          align: 'right', width: 72,
          render: (_, r) => (r.pending || r.accept_rate === undefined || r.accept_rate === null
            ? dash : cell(r, `${(r.accept_rate * 100).toFixed(0)}%`)),
        },
        {
          title: <ColTitle en="Stdev" zh="標準差" tip="多次之間 Decode tok/s 的標準差" />,
          align: 'right', width: 72,
          render: (_, r) => (r.pending || r.samples < 2 ? (
            <Tooltip title={r.pending ? undefined : '只跑 1 次，沒有標準差'}>{dash}</Tooltip>
          ) : (
            <Tooltip title={`${r.samples} 次的 Decode tok/s`}>
              <span style={num}>±{fmtTps(r.gen_tps_stdev)}</span>
            </Tooltip>
          )),
        },
        {
          title: <ColTitle en="Output" unit="tok" zh="實際長度" tip="實際生成的 token 數（平均）" />,
          align: 'right', width: 84,
          render: (_, r) => {
            if (r.pending) return dash;
            const value = <span style={num}>{Math.round(r.output_tokens)}</span>;
            return r.ignore_eos ? value : (
              <Tooltip title="引擎不支援 ignore_eos，改用寫長文的題目，長度以實際為準">
                <span style={{ borderBottom: `1px dotted ${LINE.strong}` }}>{value}</span>
              </Tooltip>
            );
          },
        },
      ]}
    />
  );
}

/**
 * The hover readout, the same for every chart here: the value leads, the
 * run follows, and a short stroke in the run's colour keys it -- the text
 * itself stays in ink, never in the series colour.
 */
export function Readout({ heading, rows }: {
  heading: React.ReactNode;
  rows: { key: string; colour?: string; value: string; label?: string }[];
}) {
  return (
    <div style={{
      background: SURFACE.container, border: `1px solid ${LINE.soft}`,
      borderRadius: 4, fontSize: 11, padding: '6px 9px', minWidth: 120, maxWidth: 300,
      boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
    }}>
      <div style={{ opacity: 0.55, marginBottom: 4 }}>{heading}</div>
      {rows.map((r) => (
        <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: 1.7 }}>
          <span style={{ width: 12, height: 2, borderRadius: 1, background: r.colour, flex: 'none' }} />
          <span style={{ ...num, fontWeight: 600 }}>{r.value}</span>
          {r.label && (
            // The legend holds the full name; here it only has to say which.
            <span style={{
              opacity: 0.55, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {r.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A run's letter on a swatch of its colour, tying a table column to a chart
 * mark. The letter is dark ink on the fill rather than the colour on dark:
 * as 11 px text the run colours do not clear text contrast; as a fill with
 * ink on it they do.
 */
export function RunMark({ index }: { index: number }) {
  const mark = RUN_MARKS[index];
  if (!mark) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
      width: 18, height: 18, borderRadius: 3, fontSize: 11, fontFamily: MONO, lineHeight: 1,
      fontWeight: 600, background: mark.colour, color: SURFACE.page,
    }}>
      {mark.letter}
    </span>
  );
}
