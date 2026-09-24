import { useEffect, useRef, useState } from 'react';
import { MONO } from '../theme';

/**
 * Something slow is happening, and this says what.
 *
 * A ring, a label and a clock. The ring fills when the stage has a real
 * fraction to show -- nodes updated out of nodes queued -- and turns when it
 * does not, because a bar that creeps toward a number nobody knows is a
 * guess drawn as a measurement. The label names the stage in the words of
 * what is actually happening, and the clock counts from when that stage
 * began: a new label restarts it, since "restarting, 40s" means something
 * and "restarting, 6m" (counted from the update before it) does not.
 */
export default function WaitingStatus({ label, percent }: {
  label: string;
  /** 0-100 when known; omitted for a stage with no measurable progress. */
  percent?: number;
}) {
  const since = useRef(performance.now());
  const stage = useRef(label.replace(/\d+\s*\/\s*\d+/, ''));
  const [now, setNow] = useState(() => performance.now());

  // Counted per stage, not per label: "更新節點中 3/42" and "4/42" are one
  // stage and must not reset the clock at every node.
  const key = label.replace(/\d+\s*\/\s*\d+/, '');
  if (key !== stage.current) {
    stage.current = key;
    since.current = performance.now();
  }

  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, []);

  const seconds = Math.max(0, (now - since.current) / 1000);
  const elapsed = seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;

  const size = 14;
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const known = percent !== undefined && Number.isFinite(percent);
  const filled = known ? Math.min(100, Math.max(0, percent!)) / 100 : 0.28;

  return (
    <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden
           className={known ? undefined : 'ws-spin'} style={{ flex: 'none' }}>
        <circle cx="7" cy="7" r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
        <circle cx="7" cy="7" r={r} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2"
                strokeLinecap="round" strokeDasharray={`${filled * c} ${c}`}
                transform="rotate(-90 7 7)"
                style={{ transition: known ? 'stroke-dasharray 400ms ease' : undefined }} />
      </svg>
      <span className="ws-label" style={{ fontSize: 12, fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 11, fontFamily: MONO, opacity: 0.45, fontVariantNumeric: 'tabular-nums' }}>
        {elapsed}
      </span>
    </span>
  );
}
