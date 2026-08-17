import { Card, Progress, Space, Tooltip, Typography } from 'antd';
import { ACCENT, LINE, MONO } from '../theme';
import type { SystemSample } from '../api';

const { Text } = Typography;

const gib = (bytes: number) => bytes / 1024 ** 3;

/**
 * CPU, memory and disk, as dials.
 *
 * Three linear bars before this, which is the correct form for a ratio against
 * a limit and reads as a row of undifferentiated lines when there are three of
 * them side by side. An arc is the same meter bent: the same single ratio, the
 * same one-hue track, no second scale and no needle -- the number sits in the
 * middle where a needle would point, which is more precise than an angle and
 * cannot be misread off a curve.
 *
 * antd draws it: `type="dashboard"` is a circle with a gap at the bottom, which
 * is the gauge shape without any of the chrome that usually comes with one. No
 * chart library, no second dependency.
 *
 * The colour is a status ramp and never carries meaning alone -- the percentage
 * is written inside every dial and the name above it, so a reader who cannot
 * separate amber from white still has both.
 */

/** Amber before red: the point of a warning is to arrive before the failure. */
function strokeFor(percent: number): string {
  if (percent >= 90) return ACCENT.error;
  if (percent >= 75) return ACCENT.warn;
  return 'rgba(255,255,255,0.82)';
}

function formatUptime(seconds: number | null): string {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小時`;
  if (hours) return `${hours} 小時 ${minutes} 分`;
  return `${minutes} 分`;
}

/**
 * One dial.
 *
 * `percent` may be null, which is not zero: the CPU figure needs two samples
 * before it means anything, and a fabricated 0% would read as an idle machine
 * rather than as unknown.
 */
function Dial({ title, percent, reading, note, noteTitle }: {
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
      <Text style={{ fontSize: 10, letterSpacing: 1.2, opacity: 0.45 }}>{title}</Text>
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
      <div style={{ marginTop: -2 }}>
        {noteTitle ? <Tooltip title={noteTitle}>{body}</Tooltip> : body}
      </div>
    </div>
  );
}

export default function SystemStats({ sample }: { sample: SystemSample | null }) {
  const cpu = sample?.cpu;
  const mem = sample?.memory;
  const swap = sample?.swap;
  const disk = sample?.disks?.[0];

  return (
    <Card
      title="系統"
      size="small"
      extra={
        sample && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            開機 {formatUptime(sample.uptime_seconds)}
          </Text>
        )
      }
    >
      {/* auto-fit rather than three fixed columns, so the dials stay centred in
          whatever they are given and drop to one per row on a phone. */}
      <div style={{
        display: 'grid', gap: 16, justifyItems: 'center',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
      }}>
        <Dial
          title="CPU"
          percent={cpu?.percent ?? null}
          reading={`${cpu?.cores ?? '—'} 執行緒`}
          note={`負載 ${cpu?.load?.join(' / ') ?? '—'}`}
          noteTitle="1、5、15 分鐘的平均可執行行程數。超過執行緒數就代表有東西在排隊。"
        />
        <Dial
          title="記憶體"
          percent={mem?.percent ?? null}
          reading={mem ? `${gib(mem.used_bytes).toFixed(1)}/${gib(mem.total_bytes).toFixed(0)}G` : '—'}
          note={
            `可用 ${mem ? gib(mem.available_bytes).toFixed(1) : '—'} GiB`
            + (swap && swap.total_bytes > 0 ? ` ・ swap ${swap.percent.toFixed(0)}%` : '')
          }
        />
        {disk ? (
          <Dial
            title={disk.path === '/' ? '磁碟' : `磁碟 ${disk.path}`}
            percent={disk.percent}
            reading={`${gib(disk.used_bytes).toFixed(0)}/${gib(disk.total_bytes).toFixed(0)}G`}
            // Available, not total-minus-used: this is the number that decides
            // whether the next model fits.
            note={`可用 ${gib(disk.free_bytes).toFixed(0)} GiB`}
            // The three parts are given together because they must add up;
            // listing only used and available makes the arithmetic look wrong,
            // since the reserve is missing from it.
            noteTitle={
              `已用 ${gib(disk.used_bytes).toFixed(1)} + 可用 ${gib(disk.free_bytes).toFixed(1)}`
              + ` + 系統保留 ${gib(disk.reserved_bytes).toFixed(1)} = ${gib(disk.total_bytes).toFixed(1)} GiB。`
              + ' 保留區是檔案系統留給 root 的空間（ext4 預設 5%），一般程序寫不進去。'
            }
          />
        ) : (
          <Dial title="磁碟" percent={null} reading="—" note="—" />
        )}
      </div>

      {/* Any disk beyond the first, as a line rather than a dial: a second
          mount is usually somewhere models are kept, and it is worth reporting
          without giving it the same weight as the root filesystem. */}
      {(sample?.disks ?? []).slice(1).map((extra) => (
        <Space key={extra.path} size={8} style={{ marginTop: 10 }}>
          <Text style={{ fontSize: 11, opacity: 0.5, fontFamily: MONO }}>{extra.path}</Text>
          <Text style={{ fontSize: 11, opacity: 0.7 }}>
            {extra.percent.toFixed(0)}% ・ 可用 {gib(extra.free_bytes).toFixed(0)} GiB
          </Text>
        </Space>
      ))}
    </Card>
  );
}
