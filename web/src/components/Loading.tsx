import { useEffect, useRef, useState } from 'react';
import './loading.css';

/**
 * Work that has started and has not finished.
 *
 * A three-by-three grid of cells with a wavefront crossing it, a label that
 * shimmers, and an elapsed count. Structure and motion follow beautifului.dev's
 * Loading State primitive; the colours are this console's.
 *
 * The three parts each answer something a spinner does not. The grid says the
 * page is alive rather than wedged. The label says what is being waited on,
 * because "loading" over a twelve-megabyte download and over a local call are
 * different situations and only one of them warrants patience. The timer is
 * the part that matters most: a static indicator cannot distinguish slow from
 * stuck, and the difference between four seconds and forty is the whole of
 * what somebody watching wants to know.
 *
 * Small enough to sit inline in a sentence, so it can be used wherever
 * something is pending rather than only on a page of its own.
 */

/**
 * A chevron sweeping left to right.
 *
 * The delay of a cell is its column plus its distance from the middle row, so
 * the lit cells form a `>` travelling across. The cycle is deliberately shorter
 * than the sweep takes, which keeps two wavefronts in flight at once -- one
 * arriving as the last leaves, rather than a pulse and a pause.
 */
const CHEVRON = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const column = i % 3;
  return (column + Math.abs(row - 1)) * 90;
});

/** A single cell travelling the perimeter, for waits with no direction to
 *  them. The centre never lights, which is what makes the path read as a
 *  circuit rather than as noise. */
const RING = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT = Array.from({ length: 9 }, (_, i) => {
  const place = RING.indexOf(i);
  return place === -1 ? null : place * 110;
});

const PATTERNS = {
  drive: { delays: CHEVRON, duration: 650, round: false },
  dots: { delays: CHEVRON, duration: 650, round: true },
  orbit: { delays: ORBIT, duration: 950, round: false },
} as const;

export type LoaderPattern = keyof typeof PATTERNS;

export function LoaderGrid({ pattern = 'drive' }: { pattern?: LoaderPattern }) {
  const { delays, duration, round } = PATTERNS[pattern];
  return (
    <span aria-hidden className="lg-grid">
      {delays.map((delay, i) => (
        <span
          key={i}
          className={round ? 'lg-cell lg-cell-round' : 'lg-cell'}
          style={delay === null
            ? { opacity: 0.07 }
            : { opacity: 0.15, animation: `lg-on ${duration}ms ease-in-out ${delay}ms infinite` }}
        />
      ))}
    </span>
  );
}

/** Tenths, because a counter that only moves once a second looks stopped for
 *  most of every second it is being watched. */
function useElapsed(since?: number): string {
  const start = useRef(since ?? performance.now());
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 100);
    return () => window.clearInterval(timer);
  }, []);

  const seconds = (performance.now() - start.current) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

export default function Loading({
  label, pattern = 'drive', since, elapsed = true,
}: {
  label: string;
  pattern?: LoaderPattern;
  /** performance.now() when the work began, if it began before this mounted. */
  since?: number;
  elapsed?: boolean;
}) {
  const time = useElapsed(since);
  return (
    <div role="status" className="lg-root">
      <LoaderGrid pattern={pattern} />
      <span className="lg-label">{label}</span>
      {elapsed && <span className="lg-elapsed">{time}</span>}
    </div>
  );
}
