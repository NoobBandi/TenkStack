/**
 * The height the two request panels share.
 *
 * They sit in a stretch row, so the shorter is stretched to the taller and
 * spends the difference on empty space below its axis. Matching them by hand
 * worked until one of the numbers moved: the request card is a header, a chart
 * and a fixed list, the depth card is a header and a chart, and nothing tied
 * the two sums together.
 *
 * Now they are derived from the same parts. Change a part and both follow.
 */

/** The headline row: a 22px figure at line-height 1, plus its 8px margin.
 *
 *  Both cards build this row identically, which is why the two totals stay
 *  equal whatever this number is -- it appears on both sides and cancels. It
 *  still has to be right, because the request card's empty state draws a spacer
 *  of exactly this height in place of a headline it has no figure for. */
export const PANEL_HEADER_H = 30;

/** The request chart. Kept smaller than the depth chart's share because the
 *  list below it is doing work the plot would otherwise have to. */
export const REQUEST_CHART_H = 132;

/** The whole list block: its top margin and rule, then four rows of 22px.
 *  Fixed rather than capped -- a maximum still grows on the way to it, and the
 *  point is a card whose height never moves. */
export const TRACE_LIST_CHROME_H = 17;
export const TRACE_LIST_ROWS_H = 88;
export const TRACE_LIST_H = TRACE_LIST_CHROME_H + TRACE_LIST_ROWS_H;

/** What both cards come to, and what the depth chart is sized against. */
export const PANEL_BODY_H = PANEL_HEADER_H + REQUEST_CHART_H + TRACE_LIST_H;
