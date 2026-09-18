import { Progress, Tooltip, Typography } from 'antd';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * One reading as an arc.
 *
 * A linear bar is the correct form for a ratio against a limit and reads as
 * a row of undifferentiated lines when there are three of them side by side.
 * An arc is the same meter bent: the same single ratio, the same one-hue
 * track, no second scale and no needle -- the number sits in the middle where
 * a needle would point, which is more precise than an angle and cannot be
 * misread off a curve.
 *
 * antd draws it: `type="dashboard"` is a circle with a gap at the bottom, which
 * is the gauge shape without any of the chrome that usually comes with one. No
 * chart library, no second dependency.
 *
 * The colour is a status ramp and never carries meaning alone -- the percentage
 * is written inside every dial and the name above it, so a reader who cannot
 * separate amber from white still has both.
 *
 * Shared by the host panel and the ComfyUI page, so the same quantity is the
 * same instrument wherever it appears.
 */

/** Amber before red: the point of a warning is to arrive before the failure. */
function strokeFor(percent: number): string {
  if (percent >= 90) return ACCENT.error;
  if (percent >= 75) return ACCENT.warn;
  return 'rgba(255,255,255,0.82)';
}

/**
 * One dial.
 *
 * `percent` may be null, which is not zero: the CPU figure needs two samples
 * before it means anything, and a fabricated 0% would read as an idle machine
 * rather than as unknown.
 */
export default function Dial({ title, percent, reading, note, noteTitle }: {
  title: string;
  percent: number | null;
  /** The absolute figure the ratio came from — 21.3 / 46 GiB, not just 46%. */
  reading: string;
  note: string;
  noteTitle?: string;
}) {
  const value = percent ?? 0;
  const body = (
    <Text type="secondary" style={{ fontSize: 11, textAlign: 'center', display: 'block' }}>
      {note}
    </Text>
  );

  return (
    <div style={{ textAlign: 'center', minWidth: 0 }}>
      <Progress
        type="dashboard"
        percent={value}
        size={112}
        // 90 degrees of gap, at the bottom. Wider than antd's default 75: a
        // dial that nearly closes reads as a ring, and the open bottom is what
        // makes it obvious the scale starts at the left and ends at the right.
        gapDegree={90}
        gapPosition="bottom"
        strokeWidth={7}
        strokeColor={strokeFor(value)}
        // Same ramp as the fill, one step down, so the track reads as the
        // unfilled part of the same thing rather than as a second series.
        trailColor={LINE.faint}
        format={() => (
          <div style={{ lineHeight: 1.15 }}>
            {/* Tabular figures. Centred inside a circle is the one place the
                usual "proportional on a standalone value" advice fails hardest:
                a number that changes width twice a second moves its own centre,
                so the whole reading rocks inside the dial. */}
            <div style={{
              fontFamily: MONO, fontSize: 21, fontVariantNumeric: 'tabular-nums',
              color: percent === null ? LINE.strong : strokeFor(value),
            }}>
              {percent === null ? '—' : `${percent.toFixed(0)}`}
              {percent !== null && (
                <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 1 }}>%</span>
              )}
            </div>
            <div style={{ fontSize: 10, opacity: 0.45, fontFamily: MONO }}>{reading}</div>
          </div>
        )}
        style={{ marginTop: 2 }}
      />
      {/* Under the dial, not above it. A caption to one side of a circle has
          nothing to align to and reads as though it belongs to whatever is
          left of it; centred beneath, the dial and its name are obviously one
          object. */}
      <div style={{ marginTop: -4 }}>
        <Text style={{ fontSize: 11, letterSpacing: 0.6, display: 'block' }}>{title}</Text>
        {noteTitle ? <Tooltip title={noteTitle}>{body}</Tooltip> : body}
      </div>
    </div>
  );
}
