import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { PictureOutlined } from '@ant-design/icons';
import GpuChart from '../components/GpuChart';
import StatTile from '../components/StatTile';
import SystemStats from '../components/SystemStats';
import Versions from '../components/Versions';
import { useStream } from '../stream';
import {
  fetchComfy, unloadAll, type ComfyStatus, type GpuSample, type ModelInfo,
} from '../api';
import { MONO } from '../theme';
import { clockCeiling, powerCeiling, tempCeiling } from '../hardware';

const { Text } = Typography;

const STATE_COLOURS: Record<string, string> = {
  ready: 'green', starting: 'processing', stopping: 'orange', stopped: 'default',
};

/**
 * A row of tiles that fills its width whatever the count.
 *
 * Flex rather than the 24-column grid: a grid needs spans chosen up front, so
 * three tiles at span 8 filled the row while two at span 6 left a quarter of it
 * blank. Flex items share out the remainder instead, so any number of tiles
 * ends up flush, and they rewrap as the window narrows.
 */
function TileRow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' }}>
      {children}
    </div>
  );
}

/**
 * Basis, not a fixed width: below it the row wraps, above it the tiles grow to
 * share what is left.
 *
 * 150px keeps all six tiles on one line from 1280px of window upward, which
 * covers every screen this is read on. Narrower than that they wrap, and a tile
 * left alone on the last line stretches across it -- still preferable to the
 * fixed grid, which left a quarter of the row blank at every width.
 */
function Tile({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: '1 1 150px', minWidth: 0 }}>{children}</div>;
}

/**
 * One card's counters.
 *
 * Repeated per device rather than aggregated: a total tells you the machine is
 * busy but not which card is, and with models pinned to particular devices that
 * is the question actually being asked. The label is dropped when there is only
 * one card, where naming it says nothing.
 */
function gpuTiles(gpu: GpuSample, showTemp: boolean) {
  const used = gpu.memory_used_mib ?? 0;
  const total = gpu.memory_total_mib ?? 0;
  const vramPercent = total ? Math.round((used / total) * 100) : 0;
  const temp = gpu.temperature_c;

  return (
    <>
      <Tile>
        <StatTile
          label="POWER" value={(gpu.power_w ?? 0).toFixed(0)} unit="W"
          percent={((gpu.power_w ?? 0) / powerCeiling(gpu)) * 100}
          footnote={`上限 ${powerCeiling(gpu).toFixed(0)} W`}
        />
      </Tile>
      <Tile>
        <StatTile
          label="VRAM" value={(used / 1024).toFixed(1)}
          unit={`/ ${(total / 1024).toFixed(0)} GiB`}
          percent={vramPercent} warn={vramPercent > 92}
          footnote={`剩餘 ${((total - used) / 1024).toFixed(1)} GiB`}
        />
      </Tile>
      <Tile>
        <StatTile
          label="CLOCK" value={(gpu.frequency_mhz ?? 0).toFixed(0)} unit="MHz"
          percent={((gpu.frequency_mhz ?? 0) / clockCeiling(gpu)) * 100}
          footnote={`上限 ${clockCeiling(gpu).toFixed(0)} MHz`}
        />
      </Tile>
      {/* Omitted entirely when no card reports a temperature: a tile that can
          only ever read "—" is worse than one tile fewer. This B70 does report
          one, through sysfs rather than xpu-smi. */}
      {showTemp && (
        <Tile>
          <StatTile
            label="TEMP"
            value={temp === null ? '—' : temp.toFixed(0)}
            unit={temp === null ? undefined : '°C'}
            percent={temp === null ? undefined : (temp / tempCeiling(gpu)) * 100}
            warn={temp !== null && temp > tempCeiling(gpu) * 0.85}
            footnote={temp === null ? '此卡未回報'
              : `臨界 ${tempCeiling(gpu).toFixed(0)} °C`}
          />
        </Tile>
      )}
    </>
  );
}

/** The card's name, shown only when there is more than one to tell apart. */
function GpuLabel({ gpu }: { gpu: GpuSample }) {
  return (
    <Space size={8} style={{ marginBottom: 8 }}>
      <Tag style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>xpu:{gpu.index}</Tag>
      <Text style={{ fontSize: 11, opacity: 0.4 }}>{gpu.name}</Text>
      {gpu.busy && <Text style={{ fontSize: 10, opacity: 0.5 }}>運算中</Text>}
    </Space>
  );
}

export default function Dashboard() {
  const { gpus, system, models, throughput, connected, refreshModels } =
    useStream();
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);
  const [unloading, setUnloading] = useState(false);

  // ComfyUI publishes no event stream to the console, so its queue depth is
  // the one thing here that genuinely has to be polled.
  useEffect(() => {
    const load = () => fetchComfy().then(setComfy).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const onUnload = async () => {
    setUnloading(true);
    try {
      await unloadAll();
      refreshModels();
    } finally {
      setUnloading(false);
    }
  };

  const multiple = gpus.length > 1;
  const showTemp = gpus.some((g) => g.temperature_c !== null);

  /** Machine-wide, not per card: llama-swap reports one figure however many
   *  devices are serving it. */
  const globalTiles = (
    <>
      <Tile>
        <StatTile
          label="THROUGHPUT" value={(throughput?.tokens_per_second ?? 0).toFixed(1)} unit="t/s"
          footnote={throughput ? `最近 ${throughput.tokens} tokens` : '尚無資料'}
        />
      </Tile>
    </>
  );

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

      {/* One card: everything shares a row, so five tiles come out evenly and
          nothing is left hanging. Two or more: each card keeps its own labelled
          row, because tiles from different cards side by side cannot be told
          apart, and the machine-wide figures follow in a row of their own. */}
      {multiple ? (
        <>
          {gpus.map((g) => (
            <div key={g.index}>
              <GpuLabel gpu={g} />
              <TileRow>{gpuTiles(g, showTemp)}</TileRow>
            </div>
          ))}
          <TileRow>{globalTiles}</TileRow>
        </>
      ) : (
        <TileRow>
          {gpus.length === 0 ? (
            <Tile><StatTile label="GPU" value="—" footnote="xpu-smi 無回應" /></Tile>
          ) : (
            gpuTiles(gpus[0], showTemp)
          )}
          {globalTiles}
        </TileRow>
      )}

      {/* Rendered bare rather than in a Row: antd gives a gutter Row negative
          inline margins, which made this block sit 6px wider on each side than
          the tiles above it. Full width now that the log has its own page, so
          the two line up. */}
      <GpuChart latest={gpus} />

      <SystemStats sample={system} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' }}>
        <div style={{ flex: '2 1 420px', minWidth: 0 }}>
          <Card
            title={<span style={{ fontSize: 12, opacity: 0.75 }}>模型</span>}
            size="small"
            style={{ height: '100%' }}
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
                  title: '名稱', dataIndex: 'name',
                  render: (name: string | undefined, row) => (
                    <div>
                      <div>{name || row.id}</div>
                      <Text type="secondary" style={{ fontSize: 11 }}>{row.id}</Text>
                    </div>
                  ),
                },
                {
                  title: '狀態', dataIndex: 'state', width: 100,
                  render: (state: string) => (
                    <Tag color={STATE_COLOURS[state] ?? 'default'}>{state}</Tag>
                  ),
                },
                {
                  title: 'CONTEXT', dataIndex: 'ctx_size', width: 100,
                  render: (n: number | null | undefined) => (
                    <Text style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
                      {n ? `${Math.round(n / 1024)}K` : '—'}
                    </Text>
                  ),
                },
                {
                  title: 'TTL', dataIndex: 'ttl', width: 70,
                  render: (ttl: number | null | undefined) =>
                    ttl ? `${Math.round(ttl / 60)} 分` : '—',
                },
              ]}
            />
          </Card>
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <Card
            title={<span style={{ fontSize: 12, opacity: 0.75 }}><PictureOutlined /> ComfyUI</span>}
            size="small"
            style={{ height: '100%' }}
          >
            {comfy?.reachable ? (
              <Row gutter={16}>
                <Col span={12}><Statistic title="佇列中" value={comfy.queue_pending ?? 0} /></Col>
                <Col span={12}><Statistic title="執行中" value={comfy.queue_running ?? 0} /></Col>
                <Col span={24} style={{ marginTop: 10 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>版本 {comfy.version}</Text>
                </Col>
              </Row>
            ) : (
              <Alert type="info" showIcon message="ComfyUI 未執行" />
            )}
          </Card>
        </div>
      </div>

      <Versions />

    </div>
  );
}
