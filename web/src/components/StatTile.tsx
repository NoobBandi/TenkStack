import { Card, Typography } from 'antd';
import { ACCENT, MONO, meterFill } from '../theme';

const { Text } = Typography;

/**
 * One reading, in a fixed shape.
 *
 * The four readings used to misalign because each carried different furniture —
 * one had a progress bar, another two lines of caption. Identical structure is
 * what keeps a row of numbers on the same baseline, so every one always renders
 * label, value, bar and footnote, drawing the bar as an empty track when there
 * is no ratio to show.
 *
 * Split in two because a reading is not always a card. Four readings belonging
 * to one GPU are four cells inside that card, and giving each its own border
 * made a row of five boxes that said nothing about which two things were
 * related.
 */

interface Props {
  label: string;
  value: string;
  unit?: string;
  /** 0-100, or undefined when the reading is not a proportion. */
  percent?: number;
  footnote?: string;
  warn?: boolean;
  /** Where this reading turns amber and where it turns red, as percentages of
   *  its own ceiling. Given these, the bar grades across the thresholds rather
   *  than flipping colour all at once, so the reader sees how far into the
   *  warning they are and not merely that they are in it. */
  thresholds?: [number, number];
}

export function StatBody({
  label, value, unit, percent, footnote, warn, thresholds,
}: Props) {
  const [amber, red] = thresholds ?? [Infinity, Infinity];
  const level = percent === undefined ? 0
    : percent >= red ? 2 : percent >= amber ? 1 : 0;
  const ink = level === 2 ? ACCENT.error : level === 1 || warn ? ACCENT.warn : undefined;
  return (
    <div style={{ minWidth: 0 }}>
      <Text style={{ fontSize: 10, letterSpacing: 1.2, opacity: 0.45 }}>{label}</Text>

      <div style={{
        fontFamily: MONO, fontSize: 24, lineHeight: 1.25, marginTop: 2,
        color: ink,
        // Tabular figures, against the usual advice for a standalone value
        // ("equal-width digits look loose at display sizes"). That advice
        // assumes a static hero number. This one is replaced every two seconds,
        // and proportional digits make the unit beside it slide left and right
        // on every sample -- a jitter that is far more distracting at 24px than
        // slightly wide zeros are.
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
        {unit && <span style={{ fontSize: 12, opacity: 0.45, marginLeft: 4 }}>{unit}</span>}
      </div>

      <div className="meter" style={{ margin: '9px 0 6px' }}>
        {percent !== undefined && (
          <div style={{
            height: '100%', width: `${Math.max(0, Math.min(100, percent))}%`,
            background: thresholds ? meterFill(percent, amber, red)
              : warn ? ACCENT.warn : 'rgba(255,255,255,0.8)',
            borderRadius: 1, transition: 'width 400ms ease',
          }} />
        )}
      </div>

      {/* Always rendered, even when empty, so readings keep a common height. */}
      <Text style={{ fontSize: 11, opacity: 0.4, display: 'block', minHeight: 17 }}>
        {footnote ?? ' '}
      </Text>
    </div>
  );
}

/** The same reading with its own card around it, for one that stands alone. */
export default function StatTile(props: Props) {
  return (
    <Card size="small" style={{ height: '100%' }} styles={{ body: { padding: 14 } }}>
      <StatBody {...props} />
    </Card>
  );
}
