import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, Empty, Progress, Row, Statistic, Table, Tag, Typography,
} from 'antd';
import { ThunderboltOutlined, DatabaseOutlined, DashboardOutlined, PictureOutlined } from '@ant-design/icons';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import Endpoints from '../components/Endpoints';
import SystemStats from '../components/SystemStats';
import {
  fetchComfy, fetchModels, subscribe, unloadAll,
  type ComfyStatus, type GpuSample, type ModelInfo, type StreamEvent, type SystemSample,
  type Throughput,
} from '../api';

const { Text } = Typography;

/** ~60 samples at one every 2s is two minutes of history, which is enough to
 *  see a generation start and finish without turning the chart into a smear. */
const HISTORY_LENGTH = 60;

interface Point {
  t: number;
  power: number;
  vram: number;
  freq: number;
}

const STATE_COLOURS: Record<string, string> = {
  ready: 'green',
  starting: 'processing',
  stopping: 'orange',
  stopped: 'default',
};

export default function Dashboard() {
  const [gpu, setGpu] = useState<GpuSample | null>(null);
  const [history, setHistory] = useState<Point[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);
  const [throughput, setThroughput] = useState<Throughput | null>(null);
  const [sys, setSys] = useState<SystemSample | null>(null);
  const [connected, setConnected] = useState(true);
  const [unloading, setUnloading] = useState(false);
  const startedAt = useRef(Date.now());

  const refresh = useCallback(() => {
    fetchModels().then(setModels).catch(() => undefined);
    fetchComfy().then(setComfy).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    // ComfyUI has no event stream of its own, so its queue depth is the one
    // thing here that genuinely has to be polled.
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = subscribe((event: StreamEvent) => {
      if (event.type === 'gpu') {
        const sample = event.data as GpuSample;
        setGpu(sample);
        setHistory((prev) => [
          ...prev.slice(-(HISTORY_LENGTH - 1)),
          {
            t: Math.round((Date.now() - startedAt.current) / 1000),
            power: sample.power_w ?? 0,
            vram: sample.memory_used_mib ?? 0,
            freq: sample.frequency_mhz ?? 0,
          },
        ]);
      } else if (event.type === 'modelStatus') {
        // Full array on every change, not a delta, so replace rather than merge.
        const next = event.data as ModelInfo[];
        setModels((prev) =>
          next.map((m) => ({
            ...m,
            running: m.state === 'ready' || m.state === 'starting',
            proxy: prev.find((p) => p.id === m.id)?.proxy ?? null,
          })),
        );
      } else if (event.type === 'throughput') {
        setThroughput(event.data as Throughput);
      } else if (event.type === 'system') {
        setSys(event.data as SystemSample);
      }
    }, setConnected);
    return unsubscribe;
  }, []);

  const onUnload = async () => {
    setUnloading(true);
    try {
      await unloadAll();
      refresh();
    } finally {
      setUnloading(false);
    }
  };

  const vramUsed = gpu?.memory_used_mib ?? 0;
  const vramTotal = gpu?.memory_total_mib ?? 0;
  const vramPercent = vramTotal ? Math.round((vramUsed / vramTotal) * 100) : 0;
  const vramFreeGib = ((vramTotal - vramUsed) / 1024).toFixed(1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!connected && (
        <Alert
          type="warning"
          showIcon
          message="與後端的連線中斷"
          description="畫面上的數值可能已經過期。連線恢復後會自動更新。"
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="GPU 功耗"
              value={gpu?.power_w ?? 0}
              precision={0}
              suffix="W"
              prefix={<ThunderboltOutlined />}
              valueStyle={{ color: gpu?.busy ? '#cf1322' : undefined }}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              閒置約 46 W ・ {gpu?.busy ? '運算中' : '閒置'}
            </Text>
          </Card>
        </Col>

        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="顯存"
              value={(vramUsed / 1024).toFixed(1)}
              suffix={`/ ${(vramTotal / 1024).toFixed(0)} GiB`}
              prefix={<DatabaseOutlined />}
            />
            <Progress
              percent={vramPercent}
              size="small"
              status={vramPercent > 90 ? 'exception' : 'normal'}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>剩餘 {vramFreeGib} GiB</Text>
          </Card>
        </Col>

        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="核心頻率"
              value={gpu?.frequency_mhz ?? 0}
              precision={0}
              suffix="MHz"
              prefix={<DashboardOutlined />}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>閒置 400 MHz</Text>
          </Card>
        </Col>

        <Col xs={24} sm={12} xl={6}>
          <Card>
            <Statistic
              title="最近生成速度"
              value={throughput?.tokens_per_second ?? 0}
              precision={1}
              suffix="t/s"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {throughput ? `${throughput.tokens} tokens` : '尚無資料'}
            </Text>
          </Card>
        </Col>
      </Row>

      <Card title={gpu?.name ?? 'GPU'} size="small">
        {history.length < 2 ? (
          <Empty description="正在收集資料…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="t" tickFormatter={(v) => `${v}s`} fontSize={12} />
              <YAxis yAxisId="power" fontSize={12} width={44} />
              <YAxis yAxisId="vram" orientation="right" fontSize={12} width={52} />
              <Tooltip
                formatter={(value) => (typeof value === 'number' ? Math.round(value) : value)}
                labelFormatter={(v) => `啟動後 ${v} 秒`}
              />
              <Area
                yAxisId="power" type="monotone" dataKey="power" name="功耗 (W)"
                stroke="#cf1322" fill="#cf1322" fillOpacity={0.15}
              />
              <Area
                yAxisId="vram" type="monotone" dataKey="vram" name="顯存 (MiB)"
                stroke="#1677ff" fill="#1677ff" fillOpacity={0.12}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      <SystemStats sample={sys} />

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            title="模型"
            size="small"
            extra={
              <Button size="small" onClick={onUnload} loading={unloading}
                      disabled={!models.some((m) => m.running)}>
                全部卸載
              </Button>
            }
          >
            <Table<ModelInfo>
              dataSource={models}
              rowKey="id"
              size="small"
              pagination={false}
              locale={{ emptyText: '設定檔中沒有模型' }}
              columns={[
                {
                  title: '名稱',
                  dataIndex: 'name',
                  render: (name: string | undefined, row) => (
                    <div>
                      <div>{name || row.id}</div>
                      <Text type="secondary" style={{ fontSize: 12 }}>{row.id}</Text>
                    </div>
                  ),
                },
                {
                  title: '狀態',
                  dataIndex: 'state',
                  width: 110,
                  render: (state: string) => (
                    <Tag color={STATE_COLOURS[state] ?? 'default'}>{state}</Tag>
                  ),
                },
                {
                  title: 'TTL',
                  dataIndex: 'ttl',
                  width: 90,
                  render: (ttl: number | null | undefined) =>
                    ttl ? `${Math.round(ttl / 60)} 分` : '—',
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} xl={8}>
          <Card title={<><PictureOutlined /> ComfyUI</>} size="small">
            {comfy?.reachable ? (
              <Row gutter={16}>
                <Col span={12}>
                  <Statistic title="佇列中" value={comfy.queue_pending ?? 0} />
                </Col>
                <Col span={12}>
                  <Statistic title="執行中" value={comfy.queue_running ?? 0} />
                </Col>
                <Col span={24} style={{ marginTop: 12 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    版本 {comfy.version}
                  </Text>
                </Col>
              </Row>
            ) : (
              <Alert type="info" showIcon message="ComfyUI 未執行" />
            )}
          </Card>
        </Col>
      </Row>

      <Endpoints />
    </div>
  );
}
