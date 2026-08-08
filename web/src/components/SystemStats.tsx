import { Card, Col, Progress, Row, Space, Tooltip, Typography } from 'antd';
import { HddOutlined } from '@ant-design/icons';
import type { SystemSample } from '../api';

const { Text } = Typography;

const gib = (bytes: number) => bytes / 1024 ** 3;

/** Amber before red: the point of a warning is to arrive before the failure. */
function statusOf(percent: number): 'normal' | 'active' | 'exception' {
  if (percent >= 90) return 'exception';
  if (percent >= 75) return 'active';
  return 'normal';
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

export default function SystemStats({ sample }: { sample: SystemSample | null }) {
  const cpu = sample?.cpu;
  const mem = sample?.memory;
  const swap = sample?.swap;

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
      <Row gutter={[24, 16]}>
        <Col xs={24} md={8}>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text strong style={{ fontSize: 13 }}>CPU</Text>
              <Text style={{ fontSize: 13 }}>
                {/* null, not zero, until two samples exist -- a fabricated 0%
                    would read as an idle machine rather than as unknown. */}
                {cpu?.percent === null || cpu?.percent === undefined
                  ? '—'
                  : `${cpu.percent.toFixed(0)}%`}
              </Text>
            </Space>
            <Progress
              percent={cpu?.percent ?? 0}
              size="small"
              showInfo={false}
              status={statusOf(cpu?.percent ?? 0)}
            />
            <Tooltip title={cpu?.model ?? ''}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {cpu?.cores ?? '—'} 執行緒 ・ 負載 {cpu?.load?.join(' / ') ?? '—'}
              </Text>
            </Tooltip>
          </Space>
        </Col>

        <Col xs={24} md={8}>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text strong style={{ fontSize: 13 }}>記憶體</Text>
              <Text style={{ fontSize: 13 }}>
                {mem ? `${gib(mem.used_bytes).toFixed(1)} / ${gib(mem.total_bytes).toFixed(0)} GiB` : '—'}
              </Text>
            </Space>
            <Progress
              percent={mem?.percent ?? 0}
              size="small"
              showInfo={false}
              status={statusOf(mem?.percent ?? 0)}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              可用 {mem ? gib(mem.available_bytes).toFixed(1) : '—'} GiB
              {swap && swap.total_bytes > 0 && ` ・ swap ${swap.percent.toFixed(0)}%`}
            </Text>
          </Space>
        </Col>

        <Col xs={24} md={8}>
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            {(sample?.disks ?? []).map((disk) => (
              <Space key={disk.path} direction="vertical" size={2} style={{ width: '100%' }}>
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Text strong style={{ fontSize: 13 }}>
                    <HddOutlined /> {disk.path}
                  </Text>
                  <Text style={{ fontSize: 13 }}>
                    {gib(disk.used_bytes).toFixed(0)} / {gib(disk.total_bytes).toFixed(0)} GiB
                  </Text>
                </Space>
                <Progress
                  percent={disk.percent}
                  size="small"
                  showInfo={false}
                  status={statusOf(disk.percent)}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  剩餘 {gib(disk.free_bytes).toFixed(0)} GiB
                </Text>
              </Space>
            ))}
            {!sample?.disks?.length && <Text type="secondary" style={{ fontSize: 12 }}>—</Text>}
          </Space>
        </Col>
      </Row>
    </Card>
  );
}
