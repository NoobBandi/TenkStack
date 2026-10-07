import { Tooltip } from 'antd';
import { LINE, MONO } from '../../theme';
import { RUN_MARKS } from './labels';
import { Row } from './motion';
import type { RunView } from './metrics';

const num: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' };

/**
 * One run's value as a horizontal bar on a shared scale, the figure at its
 * right in a fixed slot so a column of them lines up. Comparing, a small
 * letter in front says whose bar it is, so the colour is never the only cue.
 * `tick` marks a reference on the track -- the ideal on 多人同時's total.
 */
export function BarLine({ run, value, top, text, tip, tick, comparing, height = 8, valueWidth = 60 }: {
  run: RunView;
  value: number | undefined | null;
  top: number;
  text: string;
  tip?: React.ReactNode;
  tick?: number;
  comparing: boolean;
  height?: number;
  valueWidth?: number;
}) {
  const mark = RUN_MARKS[run.mark];
  const has = value != null && Number.isFinite(value);
  const frac = has ? Math.max(0, Math.min(1, value / top)) : 0;
  const line = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
      <span className="bn-mark-slot" style={{
        width: comparing ? 10 : 0, opacity: comparing ? 1 : 0,
        ...num, fontSize: 10, color: 'rgba(255,255,255,0.55)',
      }}>
        {mark?.letter}
      </span>
      <div style={{ position: 'relative', flex: 1, minWidth: 40, height }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 2, background: LINE.faint }} />
        {has && (
          <div className="bn-bar" style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, minWidth: 2,
            background: mark?.colour, borderRadius: '0 3px 3px 0',
          }} />
        )}
        {tick !== undefined && Number.isFinite(tick) && (
          <div className="bn-bar" style={{
            position: 'absolute', top: -2, bottom: -2, width: 2, borderRadius: 1,
            left: `calc(${Math.min(1, tick / top) * 100}% - 1px)`, background: 'rgba(255,255,255,0.7)',
          }} />
        )}
      </div>
      <span style={{
        ...num, width: valueWidth, flex: 'none', textAlign: 'right', fontSize: 12,
        color: has ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.35)',
      }}>
        {has ? text : '—'}
      </span>
    </div>
  );
  return (
    <Row leaving={run.leaving}>
      {tip ? <Tooltip title={tip} placement="topLeft" mouseEnterDelay={0.15}>{line}</Tooltip> : line}
    </Row>
  );
}
