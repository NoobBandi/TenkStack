import type { BenchCaseResult, BenchRun } from '../../api';
import { MONO } from '../../theme';
import { fmtMs, fmtPromptTps, fmtTps, fmtWhen, tierLabel } from './labels';

/**
 * What the page derives from a run's case results: the headline numbers,
 * the three tables of 詳細, and the Markdown that 複製成文字 puts on the
 * clipboard. Kept apart from the components so the tables and the copied
 * text cannot say different things.
 */

/** Tokens generated per request in suite v1. The submission names the suite
 *  but does not repeat its settings, and the row names need the number. */
export const TG = 256;

/** The single-request depth cases, with the prompt size llama-bench's
 *  notation names them by. Beyond 1k a depth is its nominal size less 512,
 *  so it fits a context opened at exactly that size (suite.go). */
export const DEPTH_TESTS = [
  { id: 'depth-1k', pp: 1024, short: '1k' },
  { id: 'depth-8k', pp: 7680, short: '8k' },
  { id: 'depth-32k', pp: 32256, short: '32k' },
  { id: 'depth-64k', pp: 65024, short: '64k' },
  { id: 'depth-128k', pp: 130560, short: '128k' },
];
export const testName = (pp: number) => `pp${pp}/tg${TG}`;

export const STREAM_TESTS = [
  { id: 'conc-1', streams: 1 },
  { id: 'conc-2', streams: 2 },
  { id: 'conc-4', streams: 4 },
];

export const CONTENT_TESTS = [
  { id: 'content-zh', label: '中文' },
  { id: 'content-en', label: '英文' },
  { id: 'content-code', label: '程式碼' },
];

type Results = BenchCaseResult[] | null | undefined;

export const find = (results: Results, id: string) => results?.find((r) => r.case_id === id);

const finite = (v: number | undefined | null): v is number => v !== undefined && v !== null && Number.isFinite(v);

/** Milliseconds per generated token once decoding has started. */
export const tpot = (r: BenchCaseResult) => (r.gen_tps > 0 ? 1000 / r.gen_tps : undefined);
/** Seconds from sending to the last token: the wait, then the output at the
 *  decode rate. */
export const e2e = (r: BenchCaseResult) =>
  (r.gen_tps > 0 ? r.ttft_ms / 1000 + r.output_tokens / r.gen_tps : undefined);

/** The backend measures depth-1k once and reports it again as conc-1 and
 *  content-en; equal figures say that is what happened here. */
export function sameMeasurement(a?: BenchCaseResult, b?: BenchCaseResult): boolean {
  return !!a && !!b && a.ttft_ms === b.ttft_ms && a.gen_tps === b.gen_tps && a.prompt_tps === b.prompt_tps;
}

/** The one-stream, 1k measurement, wherever the run reported it. */
const base1k = (results: Results) =>
  find(results, 'depth-1k') ?? find(results, 'conc-1') ?? find(results, 'content-en');

/** One person, 1k context: what the 單人對話 card is about. */
export interface Headline {
  decode?: number;
  /** Milliseconds. */
  ttft?: number;
}

export function headline(results: Results): Headline {
  const one = base1k(results);
  return { decode: one?.gen_tps, ttft: one?.ttft_ms };
}

export interface StreamRow {
  id: string;
  streams: number;
  r: BenchCaseResult;
  /** Per stream. */
  decode: number;
  total?: number;
  speedup?: number;
}

export function streamRows(results: Results): StreamRow[] {
  const one = find(results, 'conc-1') ?? base1k(results);
  const base = one?.gen_tps;
  return STREAM_TESTS.flatMap(({ id, streams }) => {
    const r = find(results, id);
    if (!r) return [];
    // One stream's total is its own decode.
    const total = r.total_gen_tps ?? (streams === 1 ? r.gen_tps : undefined);
    return [{
      id, streams, r, decode: r.gen_tps, total,
      speedup: finite(total) && base && base > 0 ? total / base : undefined,
    }];
  });
}

export interface ContentRow {
  id: string;
  label: string;
  r: BenchCaseResult;
  /** Against English. */
  vsEn?: number;
}

export function contentRows(results: Results): ContentRow[] {
  const en = find(results, 'content-en');
  return CONTENT_TESTS.flatMap(({ id, label }) => {
    const r = find(results, id);
    if (!r) return [];
    return [{ id, label, r, vsEn: en && en.gen_tps > 0 ? r.gen_tps / en.gen_tps : undefined }];
  });
}

export const depthRows = (results: Results) =>
  DEPTH_TESTS.flatMap((t) => {
    const r = find(results, t.id);
    return r ? [{ ...t, r }] : [];
  });

export const fmtSeconds = (v: number | undefined) => (finite(v) ? v.toFixed(1) : '—');
export const fmtTimes = (v: number | undefined) => (finite(v) ? `×${v.toFixed(2)}` : '—');

/** One run, as the summary and the detail tables need it. */
export interface RunView {
  key: string;
  /** Which run mark it wears (colour, letter). */
  mark: number;
  name: string;
  results: Results;
  /** "vllm 0.30.0" */
  engine?: string;
  /** "Intel Arc Pro B70 × 2" */
  gpu?: string;
  quant?: string;
  tier?: string;
  when?: string;
  /** Unticked a moment ago and folding away: drawn, but left out of every
   *  scale and conclusion. */
  leaving?: boolean;
}

export function runView(run: BenchRun, mark: number): RunView {
  const s = run.submission;
  const gpu = s?.hardware?.gpu;
  return {
    key: String(run.id),
    mark,
    name: run.name || run.model,
    results: s?.results,
    engine: s?.engine ? [s.engine.key, s.engine.version].filter(Boolean).join(' ') : run.engine,
    gpu: gpu?.model ? `${gpu.model}${gpu.count > 1 ? ` × ${gpu.count}` : ''}` : undefined,
    quant: s?.model?.quant || undefined,
    tier: tierLabel(run.tier),
    when: fmtWhen(run.started_at),
  };
}

/** The header line: model · engine · GPU · quant · tier · date. */
export const headerParts = (v: RunView) =>
  [v.engine, v.gpu, v.quant, v.tier ? `${v.tier}檔` : undefined, v.when].filter(Boolean) as string[];

const mdTable = (head: string[], rows: string[][]) => [
  `| ${head.join(' | ')} |`,
  `|${head.map((_, i) => (i === 0 ? ' --- ' : ' ---: ')).join('|')}|`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
].join('\n');

/** The summary as Markdown, for pasting into a chat or an issue. */
export function markdown(runs: RunView[], letter: (mark: number) => string): string {
  const parts: string[] = [];
  for (const v of runs) {
    const tag = runs.length > 1 ? `${letter(v.mark)}. ` : '';
    parts.push(`### ${tag}${v.name}`, headerParts(v).join(' · '));
    const verdicts = [
      ['單人對話', chatVerdict(headline(v.results))],
      ['多人同時', crowdVerdict(v.results)],
      ['長文', longVerdict(v.results) ?? '快速檔只測 1k。'],
      ['內容類型', contentVerdict(v.results)],
    ].filter(([, t]) => t).map(([k, t]) => `- **${k}**：${t}`);
    if (verdicts.length) parts.push(verdicts.join('\n'));

    const depth = depthRows(v.results);
    if (depth.length) {
      parts.push('**單一請求 × 深度**', mdTable(
        ['Test', 'TTFT ms', 'TPOT ms', 'Prefill tok/s', 'Decode tok/s', 'E2E s'],
        depth.map(({ pp, r }) => [
          testName(pp), fmtMs(r.ttft_ms), fmtTps(tpot(r)), fmtPromptTps(r.prompt_tps),
          fmtTps(r.gen_tps), fmtSeconds(e2e(r)),
        ]),
      ));
    }
    const streams = streamRows(v.results);
    if (streams.length) {
      parts.push('**並發**', mdTable(
        ['Streams', 'Decode/路 tok/s', 'Total tok/s', 'Speedup', 'Avg TTFT ms', 'E2E s'],
        streams.map((s) => [
          String(s.streams), fmtTps(s.decode), fmtTps(s.total), fmtTimes(s.speedup),
          fmtMs(s.r.ttft_ms), fmtSeconds(e2e(s.r)),
        ]),
      ));
    }
    const content = contentRows(v.results);
    if (content.length) {
      parts.push('**內容類型**', mdTable(
        ['Content', 'Decode tok/s', 'vs 英文', 'Accept'],
        content.map((c) => [
          c.label, fmtTps(c.r.gen_tps), fmtTimes(c.vsEn),
          finite(c.r.accept_rate) ? `${Math.round(c.r.accept_rate * 100)}%` : '—',
        ]),
      ));
    }
  }
  return parts.join('\n\n') + '\n';
}

/** The top of a bar scale: the largest value with a little headroom, so the
 *  longest bar does not touch its value. */
export function scaleTop(values: (number | undefined | null)[]): number {
  const max = Math.max(0, ...values.filter((v): v is number => v != null && Number.isFinite(v)));
  return max > 0 ? max * 1.04 : 1;
}

export const AXIS_TICK = { fill: 'rgba(255,255,255,0.45)', fontSize: 10, fontFamily: MONO };

/**
 * Axis ticks at round numbers -- 0 / 50 / 100, 0 / 1,000 / 2,000 -- with the
 * top tick at or above the largest value. Recharts' own choice on an 'auto'
 * domain landed on steps like 650 and 3,500, which read as measurements.
 */
export function niceAxis(values: (number | undefined)[], count = 4): { ticks: number[]; label: (v: number) => string } {
  const max = Math.max(0, ...values.filter((v): v is number => v !== undefined && Number.isFinite(v)));
  if (max <= 0) return { ticks: [0, 1], label: (v) => String(v) };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let t = 0; t < max + step * 0.001; t += step) ticks.push(Number(t.toFixed(6)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toFixed(6)));
  const digits = step >= 1 ? 0 : 1;
  return { ticks, label: (v) => v.toLocaleString(undefined, { maximumFractionDigits: digits }) };
}


// ---------------------------------------------------------------------------
// The report card's verdicts: one plain sentence per scenario, so a newcomer
// gets the conclusion without reading a number. The thresholds are judgement
// calls for interactive use on one machine, kept here in one place so the
// cards and the copied text say the same thing.
// ---------------------------------------------------------------------------

/** The length of a typical chat answer the 單人對話 timeline is drawn for. */
export const ANSWER_TOKENS = 500;

/** Seconds to a full ANSWER_TOKENS answer: the wait, then the generation. */
export function answerSeconds(h: Headline): { wait: number; gen: number; total: number } | undefined {
  if (!finite(h.decode) || h.decode <= 0 || !finite(h.ttft)) return undefined;
  const wait = h.ttft / 1000;
  const gen = ANSWER_TOKENS / h.decode;
  return { wait, gen, total: wait + gen };
}

const secs = (s: number) => (s < 10 ? s.toFixed(1) : Math.round(s).toString());

/**
 * 單人對話. Decode decides how an answer feels once it streams:
 *   ≥ 30 tok/s  faster than anyone reads -- 「回覆很流暢」 when the first
 *               word also comes within 1 s, 「生成很流暢」 when it does not;
 *   15–30       readable, a long answer takes a while -- 「可以用，長回答要等一下」;
 *   < 15        「偏慢」.
 * A first word 2 s or more away is said as well, since that wait is felt
 * on every message. Then the time for a 500-token answer.
 */
export function chatVerdict(h: Headline): string | undefined {
  const t = answerSeconds(h);
  if (!t || !finite(h.decode)) return undefined;
  let text = h.decode >= 30 ? (t.wait < 1 ? '回覆很流暢' : '生成很流暢')
    : h.decode >= 15 ? '可以用，長回答要等一下' : '偏慢';
  if (t.wait >= 2) text += `，開始回答前要等約 ${secs(t.wait)} 秒`;
  return `${text}。一段 ${ANSWER_TOKENS} token 的回答約 ${secs(t.total)} 秒。`;
}

/** The highest stream count measured, with what it gave. */
export const topStreams = (results: Results) => streamRows(results).filter((s) => s.streams > 1).pop();

/**
 * 多人同時, read from the speedup at the most streams measured (four):
 *   ≥ 3×       「N 人同時用也撐得住，每人約 X tok/s」;
 *   1.5–3×     「多人時每人變慢，但總量有增加」;
 *   1.2–1.5×   「多人同時用時，總量只多一點」;
 *   < 1.2×     the engine serves one request at a time --
 *              「一次只服務一人，其他人要排隊（N 人時第一個字要等 S 秒）」
 *              with that case's average first-token wait.
 */
export function crowdVerdict(results: Results): string | undefined {
  const top = topStreams(results);
  if (!top || !finite(top.speedup)) return undefined;
  const n = top.streams;
  if (top.speedup >= 3) return `${n} 人同時用也撐得住，每人約 ${fmtTps(top.decode)} tok/s。`;
  if (top.speedup >= 1.5) return '多人時每人變慢，但總量有增加。';
  if (top.speedup >= 1.2) return '多人同時用時，總量只多一點。';
  return `一次只服務一人，其他人要排隊（${n} 人時第一個字要等約 ${secs(top.r.ttft_ms / 1000)} 秒）。`;
}

/**
 * 長文: how far Decode falls and how long the prompt takes to read at the
 * deepest depth measured, against 1k. Nothing when only 1k was measured.
 */
export function longVerdict(results: Results): string | undefined {
  const rows = depthRows(results);
  const base = rows.find((d) => d.id === 'depth-1k');
  const deep = rows[rows.length - 1];
  if (!base || !deep || deep === base) return undefined;
  const drop = base.r.gen_tps > 0 ? (deep.r.gen_tps / base.r.gen_tps - 1) * 100 : 0;
  return `${deep.short} 時 Decode 降到 ${fmtTps(deep.r.gen_tps)} tok/s（${drop >= 0 ? '+' : ''}${Math.round(drop)}%），`
    + `讀完 ${deep.short} 的提示要先等約 ${secs(deep.r.ttft_ms / 1000)} 秒。`;
}

/**
 * 內容類型: the fastest of 中文 / 英文 / 程式碼 and its ratio to Chinese.
 * Within 10% of each other they are called alike -- and without acceptance
 * figures that usually means no speculative decoding, which is what makes
 * them differ. With them, the content it helps most is named.
 */
export function contentVerdict(results: Results): string | undefined {
  const rows = contentRows(results);
  if (rows.length < 2) return undefined;
  const rates = rows.map((c) => c.r.gen_tps);
  const accepts = rows.filter((c) => finite(c.r.accept_rate));
  const alike = Math.max(...rates) / Math.max(1e-9, Math.min(...rates)) <= 1.1;
  if (alike) return accepts.length ? '三種內容速度相近。' : '沒有推測解碼，三種內容速度相近。';
  const fastest = rows.reduce((a, b) => (b.r.gen_tps > a.r.gen_tps ? b : a));
  const zh = rows.find((c) => c.id === 'content-zh');
  let text = fastest.id === 'content-zh' || !zh || zh.r.gen_tps <= 0
    ? `${fastest.label}最快`
    : `${fastest.label}最快（中文的 ${(fastest.r.gen_tps / zh.r.gen_tps).toFixed(1)}×）`;
  if (accepts.length) {
    const best = accepts.reduce((a, b) => ((b.r.accept_rate ?? 0) > (a.r.accept_rate ?? 0) ? b : a));
    text += `，推測解碼對${best.label}最有效（接受率 ${Math.round((best.r.accept_rate ?? 0) * 100)}%）`;
  }
  return `${text}。`;
}

/** Puts text on the clipboard. The console is often reached over plain HTTP
 *  on the LAN, where the async clipboard API does not exist, so the old
 *  selection-and-copy route is the fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the fallback.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}
