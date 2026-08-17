import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { PictureOutlined } from '@ant-design/icons';
import GpuChart from '../components/GpuChart';
import StatTile, { StatBody } from '../components/StatTile';
import SystemStats from '../components/SystemStats';
import Versions from '../components/Versions';
import { useStream } from '../stream';
import {
  fetchComfyInstances, unloadAll, type ComfyInstance, type GpuSample, type ModelInfo,
} from '../api';
import { ACCENT, LINE, MONO } from '../theme';
import { clockCeiling, deviceTag, powerCeiling, tempCeiling } from '../hardware';

const { Text } = Typography;

const STATE_COLOURS: Record<string, string> = {
  ready: 'green', starting: 'processing', stopping: 'orange', stopped: 'default',
};



/**
 * One GPU, as one block.
 *
 * The readings used to be four separate bordered tiles in a row with a caption
 * above them. With two cards in the machine that came out as eight boxes and
 * two captions, and nothing about the arrangement said which four belonged
 * together -- the only thing joining them was a line of small text that scrolled
 * away. One card per GPU, with the readings as cells inside it, makes the
 * grouping structural rather than something the reader has to remember.
 *
 * Repeated per device rather than aggregated: a total says the machine is busy
 * but not which card is, and with models pinned to particular devices that is
 * the question actually being asked.
 */
function GpuBlock({ gpu, showTemp }: { gpu: GpuSample; showTemp: boolean }) {
  const used = gpu.memory_used_mib ?? 0;
  const total = gpu.memory_total_mib ?? 0;
  const vramPercent = total ? Math.round((used / total) * 100) : 0;
  const temp = gpu.temperature_c;

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      styles={{ body: { padding: '14px 16px 8px' } }}
      title={
        <Space size={9}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: gpu.busy ? ACCENT.ok : LINE.strong,
            boxShadow: gpu.busy ? `0 0 8px ${ACCENT.ok}b3` : 'none',
            display: 'inline-block', transition: 'background 300ms, box-shadow 300ms',
          }} />
          <Text style={{ fontSize: 12 }} ellipsis>{gpu.name}</Text>
          {/* Was hardcoded `xpu:{index}`, which went on saying xpu after an
              NVIDIA card went in beside the Arc. */}
          <Tag style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>
            {deviceTag(gpu.vendor, gpu.index)}
          </Tag>
        </Space>
      }
      extra={gpu.busy && <Text style={{ fontSize: 10, opacity: 0.5 }}>運算中</Text>}
    >
      {/* Four across. 108px is what one reading needs -- "2800" at 24px plus
          its unit -- so four of them and three gaps fit inside a block from
          about 470px wide, which is what half of a 1280px window comes to.
          Below that they fall to two by two rather than crushing. */}
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))',
      }}>
        <StatBody
          label="POWER" value={(gpu.power_w ?? 0).toFixed(0)} unit="W"
          percent={((gpu.power_w ?? 0) / powerCeiling(gpu)) * 100}
          footnote={`上限 ${powerCeiling(gpu).toFixed(0)} W`}
        />
        <StatBody
          label="VRAM" value={(used / 1024).toFixed(1)}
          unit={`/ ${(total / 1024).toFixed(0)} GiB`}
          percent={vramPercent} warn={vramPercent > 92}
          footnote={`剩餘 ${((total - used) / 1024).toFixed(1)} GiB`}
        />
        <StatBody
          label="CLOCK" value={(gpu.frequency_mhz ?? 0).toFixed(0)} unit="MHz"
          percent={((gpu.frequency_mhz ?? 0) / clockCeiling(gpu)) * 100}
          footnote={`上限 ${clockCeiling(gpu).toFixed(0)} MHz`}
        />
        {/* Omitted entirely when no card reports a temperature: a cell that can
            only ever read "—" is worse than one cell fewer. */}
        {showTemp && (
          <StatBody
            label="TEMP"
            value={temp === null ? '—' : temp.toFixed(0)}
            unit={temp === null ? undefined : '°C'}
            percent={temp === null ? undefined : (temp / tempCeiling(gpu)) * 100}
            warn={temp !== null && temp > tempCeiling(gpu) * 0.85}
            footnote={temp === null ? '此卡未回報' : `臨界 ${tempCeiling(gpu).toFixed(0)} °C`}
          />
        )}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const { gpus, system, models, throughput, connected, refreshModels } =
    useStream();
  const [comfy, setComfy] = useState<ComfyInstance[] | null>(null);
  const [unloading, setUnloading] = useState(false);

  // ComfyUI publishes no event stream to the console, so its queue depth is
  // the one thing here that genuinely has to be polled.
  useEffect(() => {
    const load = () => fetchComfyInstances().then(setComfy).catch(() => undefined);
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

  const showTemp = gpus.some((g) => g.temperature_c !== null);

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

      {/*
        Two columns: the cards stacked on the left, the machine on the right.

        The machine used to span a row of its own under the cards, which at
        2560px spread three dials across 1664px with the gaps doing the
        spreading. A column beside them uses that width for a second card
        instead, and the dials keep a sensible size in what is left.

        auto-fit does the responsive part: below two columns' worth the whole
        thing becomes one, and the stack and the machine follow each other down
        the page. 460px is what the contents need -- four readings at 108px with
        their gaps and padding come to 500, three dials at 140px to 452 -- so
        the split happens exactly when both sides can use it.

        The columns will not be the same height. Two cards come to about 320px
        and the machine to about 220, so there is space under the right-hand one
        at two cards and under the left at one. Aligned to the top, which leaves
        that space at the bottom where it reads as margin, rather than stretched,
        which would put it inside a card as a void.
      */}
      <div style={{
        display: 'grid', gap: 16, alignItems: 'start',
        gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))',
      }}>
        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          {gpus.length === 0 ? (
            <StatTile label="GPU" value="—" footnote="偵測不到顯示卡" />
          ) : (
            gpus.map((g) => <GpuBlock key={g.index} gpu={g} showTemp={showTemp} />)
          )}
        </div>
        <SystemStats sample={system} throughput={throughput} />
      </div>

      {/* Rendered bare rather than in a Row: antd gives a gutter Row negative
          inline margins, which made this block sit 6px wider on each side than
          the tiles above it. Full width now that the log has its own page, so
          the two line up. */}
      <GpuChart latest={gpus} />

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
            {/* Summed across instances. The breakdown by card belongs on the
                ComfyUI page; what the dashboard is asked is only whether the
                GPUs are already busy with something other than an LLM. */}
            {comfy?.length ? (
              <Row gutter={16}>
                <Col span={12}>
                  <Statistic
                    title="佇列中"
                    value={comfy.reduce((n, i) => n + i.queue_pending, 0)}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="執行中"
                    value={comfy.reduce((n, i) => n + i.queue_running, 0)}
                  />
                </Col>
                <Col span={24} style={{ marginTop: 10 }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {comfy.length > 1 && `${comfy.length} 個實例 ・ `}
                    版本 {comfy[0].version}
                  </Text>
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
