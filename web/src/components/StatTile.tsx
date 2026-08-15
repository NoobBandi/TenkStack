import { Card, Typography } from 'antd';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * One reading, in a fixed shape.
 *
 * The four tiles used to misalign because each carried different furniture —
 * one had a progress bar, another two lines of caption. Identical structure is
 * what keeps a row of numbers on the same baseline, so every tile always
 * renders label, value, bar and footnote, drawing the bar as an empty track
 * when there is no ratio to show.
 */

interface Props {
  label: string;
  value: string;
  unit?: string;
  /** 0-100, or undefined when the reading is not a proportion. */
  percent?: number;
  footnote?: string;
  warn?: boolean;
}

export default function StatTile({ label, value, unit, percent, footnote, warn }: Props) {
  return (
    <Card size="small" style={{ height: '100%' }} styles={{ body: { padding: 14 } }}>
      <Text style={{ fontSize: 10, letterSpacing: 1.2, opacity: 0.45 }}>{label}</Text>

      <div style={{
        fontFamily: MONO, fontSize: 27, lineHeight: 1.25, marginTop: 2,
        color: warn ? '#e0a83c' : undefined,
        // Tabular figures stop the number jittering as digits change width.
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
        {unit && <span style={{ fontSize: 12, opacity: 0.45, marginLeft: 4 }}>{unit}</span>}
      </div>

      <div style={{ height: 2, background: LINE.faint, borderRadius: 1, margin: '10px 0 7px' }}>
        {percent !== undefined && (
          <div style={{
            height: '100%', width: `${Math.max(0, Math.min(100, percent))}%`,
            background: warn ? '#e0a83c' : 'rgba(255,255,255,0.8)',
            borderRadius: 1, transition: 'width 400ms ease',
          }} />
        )}
      </div>

      {/* Always rendered, even when empty, so tiles keep a common height. */}
      <Text style={{ fontSize: 11, opacity: 0.4, display: 'block', minHeight: 17 }}>
        {footnote ?? ' '}
      </Text>
    </Card>
  );
}
