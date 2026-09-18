import { Card, Space, Typography } from 'antd';
import { MONO } from '../theme';
import type { SystemSample } from '../api';
import Dial from './Dial';

const { Text } = Typography;

const gib = (bytes: number) => bytes / 1024 ** 3;

/**
 * CPU, memory and disk of the host, as dials -- see Dial for why an arc.
 */

function formatUptime(seconds: number | null): string {
  if (!seconds) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小時`;
  if (hours) return `${hours} 小時 ${minutes} 分`;
  return `${minutes} 分`;
}

export default function SystemStats({ sample }: { sample: SystemSample | null }) {
  const cpu = sample?.cpu;
  const mem = sample?.memory;
  const swap = sample?.swap;
  const disk = sample?.disks?.[0];

  return (
    <Card
      title={<span style={{ fontSize: 12, opacity: 0.75 }}>系統</span>}
      size="small"
      style={{ height: '100%' }}
      styles={{ body: { padding: '14px 16px 10px' } }}
      extra={
        sample && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            開機 {formatUptime(sample.uptime_seconds)}
          </Text>
        )
      }
    >
      {/* Three across, on one row, and capped. A dial is 112px wide and does
          not grow, so past about 500px the columns only add gap between them --
          which on a wide screen pushed the three so far apart they stopped
          reading as one group. The cap holds them together and centres the set
          in whatever it is given. */}
      <div style={{
        display: 'grid', gap: 16, justifyItems: 'center',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        maxWidth: 520, marginInline: 'auto',
      }}>
        <Dial
          title="CPU"
          percent={cpu?.percent ?? null}
          // Cores in use out of cores present, to match how memory and disk
          // read. The thread count alone was the one tile whose second line
          // described the hardware rather than the load on it, and that gap
          // matters here more than elsewhere: llama.cpp's SYCL backend spins a
          // thread waiting on the GPU, so `top` shows 100% while the machine is
          // at 7%. "1.1/16 核" says which of those two numbers this is.
          reading={
            cpu && cpu.percent !== null && cpu.cores
              ? `${(cpu.percent * cpu.cores / 100).toFixed(1)}/${cpu.cores} 核`
              : `${cpu?.cores ?? '—'} 核`
          }
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
