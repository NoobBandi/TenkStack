import type { BenchCaseResult, BenchTier } from '../../api';

/**
 * Names and number formats for the benchmark, shared by the drawer on the
 * models page and the 跑分紀錄 page so the two say the same thing the same
 * way.
 */

/** The suite's cases in the order they read best: depth, then streams, then
 *  content. Results arrive in run order, which need not be this. */
export const CASE_ORDER = [
  'depth-1k', 'depth-8k', 'depth-32k', 'depth-64k', 'depth-128k',
  'conc-1', 'conc-2', 'conc-4',
  'content-zh', 'content-en', 'content-code',
];

const CASE_LABEL: Record<string, string> = {
  'depth-1k': '深度 1k',
  'depth-8k': '深度 8k',
  'depth-32k': '深度 32k',
  'depth-64k': '深度 64k',
  'depth-128k': '深度 128k',
  'conc-1': '並發 1 路',
  'conc-2': '並發 2 路',
  'conc-4': '並發 4 路',
  'content-zh': '中文內容',
  'content-en': '英文內容',
  'content-code': '程式碼內容',
};

const CASE_HINT: Record<string, string> = {
  'depth-1k': '約 1k tokens 的上下文、單路',
  'depth-8k': '約 8k tokens 的上下文、單路',
  'depth-32k': '約 32k tokens 的上下文、單路',
  'depth-64k': '約 64k tokens 的上下文、單路，只跑 1 次',
  'depth-128k': '約 128k tokens 的上下文、單路，只跑 1 次',
  'conc-1': '1k 上下文，1 個請求',
  'conc-2': '1k 上下文，2 個請求同時跑',
  'conc-4': '1k 上下文，4 個請求同時跑',
  'content-zh': '1k 上下文、單路，中文題目',
  'content-en': '1k 上下文、單路，英文題目',
  'content-code': '1k 上下文、單路，寫程式的題目',
};

export const caseLabel = (id: string) => CASE_LABEL[id] ?? id;
export const caseHint = (id: string) => CASE_HINT[id] ?? '';

export const TIER_LABEL: Record<string, string> = { quick: '快速', full: '完整' };
export const tierLabel = (tier?: string) => (tier ? TIER_LABEL[tier] ?? tier : '—');
export const TIERS: BenchTier[] = ['quick', 'full'];

/** The depth cases, as the depth chart's x axis. */
export const DEPTHS: { id: string; label: string }[] = [
  { id: 'depth-1k', label: '1k' },
  { id: 'depth-8k', label: '8k' },
  { id: 'depth-32k', label: '32k' },
  { id: 'depth-64k', label: '64k' },
  { id: 'depth-128k', label: '128k' },
];

const rank = (id: string) => {
  const at = CASE_ORDER.indexOf(id);
  return at < 0 ? CASE_ORDER.length : at;
};

export function sortCases<T>(items: T[], id: (item: T) => string): T[] {
  return [...items].sort((a, b) => rank(id(a)) - rank(id(b)));
}

export const sortResults = (results: BenchCaseResult[] | null | undefined) =>
  sortCases(results ?? [], (r) => r.case_id);

/** "depth-32k: 超過上下文長度" -> the case and why. */
export function parseSkipped(entry: string): { id: string; reason: string } {
  const at = entry.indexOf(':');
  if (at < 0) return { id: entry.trim(), reason: '' };
  return { id: entry.slice(0, at).trim(), reason: entry.slice(at + 1).trim() };
}

/** One decimal for a generation rate; a prompt rate in the thousands gets
 *  none, where the decimal is noise that only widens the column. */
export const fmtTps = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1);
};
/** Prompt reading runs in the hundreds to thousands; a decimal there is
 *  noise, and the column reads unevenly when only some rows carry one. */
export const fmtPromptTps = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString();
export const fmtMs = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString();

/** "1 分 32 秒", "45 秒". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
}

/** An estimate, rounded the way a person would say it: "約 2 分". */
export function fmtEstimate(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  if (seconds < 60) return '不到 1 分';
  return `約 ${Math.round(seconds / 60)} 分`;
}

/** "10/07 14:05", or with the year when it is not this one. */
export function fmtWhen(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}/`;
  return `${year}${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * A JSON object as dotted paths to its leaves.
 *
 * An array of plain values is one leaf -- a tensor split of [0.5, 0.5] is one
 * setting, not two -- and an empty object is no leaves at all, so a section
 * the run left unset reads the same as one it never had.
 */
export function flatten(value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) {
      out[prefix] = value.map((v) => String(v)).join(', ');
    } else {
      value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    }
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  // The schema keeps context_length without omitempty, so a launch command
  // that names no context (Strata's) arrives as 0: unknown, not zero.
  if (prefix === 'context_length' && value === 0) return out;
  out[prefix] = String(value);
  return out;
}

/**
 * Colours and dashes for the runs side by side: the charts' series and the
 * tables' column groups wear the same mark, so A in one is A in the other,
 * and a run keeps its colour whichever others it is compared with.
 *
 * Not theme.ts SERIES: those three are one lightness and nearly one hue to a
 * protan reader (blue and violet measured ΔE 1.7 under simulation), which is
 * fine for three traces that each have their own panel and fails for three
 * bars side by side. These are the first three slots of the dataviz reference
 * palette stepped for a dark surface, checked with its validator against the
 * card surface (#0f0f0f), all pairs: worst CVD ΔE 9.4, worst normal-vision
 * ΔE 20.9, every one above 3:1. The orange is not the console's amber
 * warning or red error, and it is never used without the run's letter.
 */
export const RUN_MARKS = [
  { letter: 'A', colour: '#3987e5', dash: undefined as string | undefined },
  { letter: 'B', colour: '#d95926', dash: '6 3' },
  { letter: 'C', colour: '#199e70', dash: '2 3' },
];

/**
 * What each figure means, beside its heading: the page's glossary, kept
 * where the term is read.
 */
export const TERMS = {
  ttft: '從送出請求到收到第一個字的時間，包含讀入整段提示。越短越好。',
  prefill: '模型讀入提示的速度：每秒處理幾個提示 token。上下文越長，TTFT 越取決於它。',
  decode: '開始輸出之後每秒生成幾個 token；對話時覺得快不快，主要看它。多人同時時是每一路的平均。',
  total: '幾個請求同時跑時，全部加起來每秒生成的 token 數。白色細線是理想值：路數 × 單人的 Decode；'
    + '條碰到細線表示多人共用不吃虧，離得越遠表示越要排隊。Speedup = Total ÷ 單人 Decode。',
  accept: '推測解碼（MTP、草稿模型）先猜的 token 被採用的比例，越高生成越快。引擎有回報才有。',
  depth: `一個請求，帶不同長度的上下文。pp1024/tg256 是 llama-bench 的寫法：輸入 1024 個 token、生成 256 個 token。`,
  streams: '同時送出幾個 1k 上下文的請求，看總量能不能跟著變多。',
  content: '同樣 1k、單一請求，換成中文、英文、程式碼的題目。有推測解碼時，程式碼和英文比較好猜、接受率高，中文通常明顯較低。',
  tier: '快速檔只量 1k 深度、每項 1 次，約 1–2 分。完整檔再加 8k／32k／64k／128k 與 2 路，每項 3 次取平均'
    + '（64k、128k 各要幾分鐘，只跑 1 次），約 15–25 分。超過模型實際開的上下文長度的深度會自動略過。',
};
