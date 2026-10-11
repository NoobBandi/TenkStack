import { Tooltip } from 'antd';
import { MONO } from '../../theme';
import { RUN_MARKS } from './labels';
import { Row } from './motion';
import type { RunView } from './metrics';

const num: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' };

/**
 * One run's value as a horizontal bar on a shared scale, the figure right
 * where the bar ends. No track behind it: a grey rail under every bar read
 * as a row of progress bars, each one some way from done. Comparing, a
 * small letter in front says whose bar it is, so the colour is never the
 * only cue.
 */
export function BarLine({ run, value, top, text, tip, comparing, height = 10 }: {
  run: RunView;
  value: number | undefined | null;
  top: number;
  text: string;
  tip?: React.ReactNode;
  comparing: boolean;
  height?: number;
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
      <div style={{ flex: 1, minWidth: 40, display: 'flex', alignItems: 'center', gap: 6 }}>
        {has && (
          // The bar takes its share of the row less the figure's room, so
          // the longest bar still has its number beside it.
          <div className="bn-bar" style={{
            width: `calc((100% - 52px) * ${frac})`, minWidth: 2, height,
            background: mark?.colour, borderRadius: '0 3px 3px 0',
          }} />
        )}
        <span style={{ ...num, fontSize: 12, whiteSpace: 'nowrap', color: has ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.35)' }}>
          {has ? text : '—'}
        </span>
      </div>
    </div>
  );
  return (
    <Row leaving={run.leaving}>
      {tip ? <Tooltip title={tip} placement="topLeft" mouseEnterDelay={0.15}>{line}</Tooltip> : line}
    </Row>
  );
}
