/**
 * Whether a streaming reply has started going round in a circle.
 *
 * Thinking models sometimes fall into a loop they never leave: on this
 * machine Qwen3.8-27B once wrote the same fourteen lines of a checklist about
 * 185 times, 34,088 tokens over six minutes, and never answered. The token
 * limit would have stopped it eventually, but by then the time is gone, so
 * the chat checks the tail of what has arrived and stops the request itself.
 *
 * Two shapes are recognised, both on the tail only, since a loop is what the
 * model is doing now rather than something it did once:
 *
 * - the tail repeats exactly, with any period up to a thousand characters;
 * - in the reasoning, the recent lines are nearly all lines already written
 *   in that same stretch, which catches a loop whose cycle drifts slightly.
 *
 * The line check is not applied to the answer: a reply may legitimately
 * repeat a line many times (the cells of a grid, the rows of a table), and
 * stopping a correct answer costs more than letting a rare loop run.
 */

/** Below this much text nothing is judged: short replies are not loops. */
const MIN_CHARS = 4000;

/** How much exact repetition counts, per kind of text. */
const PERIODIC_SPAN = { reasoning: 3000, content: 6000 };
const MAX_PERIOD = 1000;

/** The line check: how far back it looks, and what counts as nearly all. */
const LINE_WINDOW = 6000;
const MIN_LINES = 40;
const MAX_DISTINCT = 0.2;
const MIN_LINE = 8;

function periodicTail(text: string, span: number): boolean {
  const n = text.length;
  if (n < span + 1) return false;
  const tail = text.slice(n - span);
  for (let period = 1; period <= MAX_PERIOD && period + span <= n; period += 1) {
    if (text.slice(n - span - period, n - period) === tail) return true;
  }
  return false;
}

function repeatedLines(text: string): boolean {
  const lines = text
    .slice(-LINE_WINDOW)
    .split(/[\n。！？]|(?<=[.!?])\s/)
    .map((l) => l.trim())
    .filter((l) => l.length >= MIN_LINE);
  // The first piece may be cut mid-line by the window.
  lines.shift();
  if (lines.length < MIN_LINES) return false;
  return new Set(lines).size / lines.length <= MAX_DISTINCT;
}

export function isLooping(text: string, kind: 'reasoning' | 'content'): boolean {
  if (text.length < MIN_CHARS) return false;
  if (periodicTail(text, PERIODIC_SPAN[kind])) return true;
  return kind === 'reasoning' && repeatedLines(text);
}

/**
 * How often to look. The check reads a few thousand characters, so it runs
 * once per this much new text rather than on every token.
 */
export const CHECK_EVERY = 500;
