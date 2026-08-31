import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import { PictureOutlined } from '@ant-design/icons';
import DepthCurve from '../components/DepthCurve';
import GpuChart from '../components/GpuChart';
import RequestCurve from '../components/RequestCurve';
import StatTile, { StatBody } from '../components/StatTile';
import SystemStats from '../components/SystemStats';
import { useStream } from '../stream';
import {
  fetchComfyInstances, unloadAll, type ComfyInstance, type GpuSample, type ModelInfo,
} from '../api';
import { ACCENT, LINE, MONO, VRAM_AMBER, VRAM_RED, meterFill } from '../theme';
import { clockCeiling, deviceTag, powerCeiling, tempCeiling } from '../hardware';

const { Text } = Typography;

const STATE_COLOURS: Record<string, string> = {
  ready: 'green', starting: 'processing', stopping: 'orange', stopped: 'default',
};



/**
 * The cards, as one block with a picker.
 *
 * One card per device was right with one device in the machine. With two it
 * put two cards in the left column against one on the right, so the columns
 * were different heights and the readings for card 1 sat below the fold of
 * everything beside them. A picker keeps the block a fixed size whatever is
 * installed, which is also what lets it line up with the machine panel.
 *
 * "All" is a real reading, not a decoration, so each measure is combined the
 * way that measure actually combines: power and VRAM add up, clock is averaged
 * because a sum of frequencies means nothing, and temperature takes the
 * highest because the hottest card is the one that throttles. Each says which
 * it did in its footnote rather than leaving the reader to assume.
 */
interface Reading {
  label: string;
  value: string;
  unit?: string;
  percent?: number;
  footnote: string;
  warn?: boolean;
  thresholds?: [number, number];
}

const ALL = 'all';

function readingsFor(gpus: GpuSample[], showTemp: boolean): Reading[] {
  const many = gpus.length > 1;
  const sum = (of: (g: GpuSample) => number | null | undefined) =>
    gpus.reduce((acc, g) => acc + (of(g) ?? 0), 0);

  const power = sum((g) => g.power_w);
  const powerCap = gpus.reduce((acc, g) => acc + powerCeiling(g), 0);

  const used = sum((g) => g.memory_used_mib);
  const total = sum((g) => g.memory_total_mib);
  const vramPercent = total ? (used / total) * 100 : 0;

  // Averaged, and only over the cards that report one: a card that is silent
  // about its clock would otherwise drag the mean towards zero.
  const clocks = gpus.map((g) => g.frequency_mhz).filter((v): v is number => v != null);
  const clock = clocks.length ? clocks.reduce((a, b) => a + b, 0) / clocks.length : null;
  const clockCap = gpus.length ? Math.max(...gpus.map((g) => clockCeiling(g))) : 1;

  const temps = gpus.map((g) => g.temperature_c).filter((v): v is number => v != null);
  const temp = temps.length ? Math.max(...temps) : null;
  const tempCap = gpus.length ? Math.max(...gpus.map((g) => tempCeiling(g))) : 1;

  const readings: Reading[] = [
    {
      label: 'POWER', value: power.toFixed(0), unit: 'W',
      percent: (power / powerCap) * 100,
      footnote: `${many ? '合計 ・ ' : ''}上限 ${powerCap.toFixed(0)} W`,
    },
    {
      label: 'VRAM', value: (used / 1024).toFixed(1),
      unit: `/ ${(total / 1024).toFixed(0)} GiB`,
      percent: vramPercent, thresholds: [VRAM_AMBER, VRAM_RED],
      footnote: `${many ? '合計 ・ ' : ''}剩餘 ${((total - used) / 1024).toFixed(1)} GiB`,
    },
    {
      label: 'CLOCK', value: clock === null ? '—' : clock.toFixed(0),
      unit: clock === null ? undefined : 'MHz',
      percent: clock === null ? undefined : (clock / clockCap) * 100,
      footnote: `${many ? '平均 ・ ' : ''}上限 ${clockCap.toFixed(0)} MHz`,
    },
  ];

  if (showTemp) {
    readings.push({
      label: 'TEMP', value: temp === null ? '—' : temp.toFixed(0),
      unit: temp === null ? undefined : '°C',
      percent: temp === null ? undefined : (temp / tempCap) * 100,
      warn: temp !== null && temp > tempCap * 0.85,
      footnote: temp === null ? '此卡未回報'
        : `${many ? '最高 ・ ' : ''}臨界 ${tempCap.toFixed(0)} °C`,
    });
  }
  return readings;
}

function GpuPanel({ gpus, showTemp }: { gpus: GpuSample[]; showTemp: boolean }) {
  // Defaults to the whole machine when there is more than one card: the first
  // question about a two-card box is nearly always how much of it is in use,
  // not which half.
  const [choice, setChoice] = useState<string>(ALL);
  const single = gpus.length === 1;
  const shown = single || choice === ALL
    ? gpus
    : gpus.filter((g) => String(g.index) === choice);
  // A card that has been removed leaves a selection pointing at nothing.
  const effective = shown.length ? shown : gpus;
  const busy = effective.some((g) => g.busy);
  const one = effective.length === 1 ? effective[0] : undefined;

  return (
    <Card
      size="small"
      // A column that fills its grid cell, so the per-card strip can be pushed
      // to the bottom. Stretched to match the machine panel beside it, which is
      // about a hundred pixels taller; without somewhere for that height to go
      // it came out as a void under the readings.
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      styles={{ body: {
        padding: '14px 16px 10px', flex: 1,
        display: 'flex', flexDirection: 'column',
      } }}
      title={
        <Space size={9}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: busy ? ACCENT.ok : LINE.strong,
            boxShadow: busy ? `0 0 8px ${ACCENT.ok}b3` : 'none',
            display: 'inline-block', transition: 'background 300ms, box-shadow 300ms',
          }} />
          {single ? (
            <>
              <Text style={{ fontSize: 12 }} ellipsis>{gpus[0].name}</Text>
              <Tag style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>
                {deviceTag(gpus[0].vendor, gpus[0].index)}
              </Tag>
            </>
          ) : (
            <Select
              size="small" variant="borderless"
              value={shown.length ? choice : ALL} onChange={setChoice}
              style={{ minWidth: 148 }} popupMatchSelectWidth={260}
              options={[
                { value: ALL, label: `全部 ${gpus.length} 張卡` },
                ...gpus.map((g) => ({
                  value: String(g.index),
                  label: `${deviceTag(g.vendor, g.index)} ・ ${g.name}`,
                })),
              ]}
            />
          )}
          {one && !single && (
            <Text style={{ fontSize: 11, opacity: 0.4 }} ellipsis>{one.name}</Text>
          )}
        </Space>
      }
      extra={busy && <Text style={{ fontSize: 10, opacity: 0.5 }}>運算中</Text>}
    >
      {/* Four across. 108px is what one reading needs -- "2800" at 24px plus
          its unit -- so four of them and three gaps fit inside a block from
          about 470px wide, which is what half of a 1280px window comes to.
          Below that they fall to two by two rather than crushing. */}
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(108px, 1fr))',
      }}>
        {readingsFor(effective, showTemp).map((r) => (
          <StatBody
            key={r.label} label={r.label} value={r.value} unit={r.unit}
            percent={r.percent} warn={r.warn} thresholds={r.thresholds}
            footnote={r.footnote}
          />
        ))}
      </div>

      {/* Every card, always -- the picker changes what the readings above
          describe, not what this shows. Keeping it constant means the block
          does not change height when the selection does, and it answers the
          question the aggregate cannot: which card is holding the memory.
          Pushed to the bottom so the height the grid hands this card lands
          between two pieces of content instead of below the last one. */}
      {gpus.length > 1 && (
        <div style={{
          marginTop: 'auto', paddingTop: 9,
          borderTop: `1px solid ${LINE.faint}`,
          display: 'grid', gap: 7,
        }}>
          {gpus.map((g) => {
            const used = g.memory_used_mib ?? 0;
            const total = g.memory_total_mib ?? 0;
            const percent = total ? (used / total) * 100 : 0;
            const lit = !single && choice === String(g.index);
            return (
              <div key={g.index} style={{
                display: 'flex', alignItems: 'center', gap: 9,
                fontSize: 10.5, fontFamily: MONO,
                opacity: lit || choice === ALL ? 1 : 0.4,
                transition: 'opacity 200ms',
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%', flex: 'none',
                  background: g.busy ? ACCENT.ok : LINE.strong,
                }} />
                <span style={{ opacity: 0.55, width: 44, flex: 'none' }}>
                  {deviceTag(g.vendor, g.index)}
                </span>
                <span className="meter" style={{ flex: 1, minWidth: 30 }}>
                  <span style={{
                    display: 'block', height: '100%', borderRadius: 1,
                    width: `${Math.min(100, percent)}%`,
                    background: meterFill(percent, VRAM_AMBER, VRAM_RED),
                    transition: 'width 400ms ease',
                  }} />
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', flex: 'none' }}>
                  {(used / 1024).toFixed(1)}
                  <span style={{ opacity: 0.4 }}>/{(total / 1024).toFixed(0)}G</span>
                </span>
                <span style={{
                  fontVariantNumeric: 'tabular-nums', opacity: 0.55,
                  width: 34, textAlign: 'right', flex: 'none',
                }}>
                  {(g.power_w ?? 0).toFixed(0)}W
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default function Dashboard() {
  const { gpus, system, models, throughput, traces, connected, refreshModels } =
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
  // The depth axis is only meaningful against a ceiling, and the ceiling is
  // whatever is loaded. Per slot, not the configured --ctx-size: a request
  // starts filling one slot, and that slot's share is what it runs out of.
  const running = models.find((m) => m.running);
  const runningCtx = running?.slots?.[0]?.n_ctx ?? running?.ctx_size ?? null;

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

        Both sides are one card now, so they are stretched to a common height
        rather than aligned to the top. The cards used to stack -- one block per
        device -- which made the left column twice as tall as the right the
        moment a second card went in, and left the readings for card 1 below
        the fold of everything beside them. The picker inside the GPU block
        keeps it one card's worth of height however many are installed.
      */}
      <div style={{
        display: 'grid', gap: 16, alignItems: 'stretch',
        gridTemplateColumns: 'repeat(auto-fit, minmax(460px, 1fr))',
      }}>
        {gpus.length === 0 ? (
          <StatTile label="GPU" value="—" footnote="偵測不到顯示卡" />
        ) : (
          <GpuPanel gpus={gpus} showTemp={showTemp} />
        )}
        <SystemStats sample={system} throughput={throughput} />
      </div>

      {/* Rendered bare rather than in a Row: antd gives a gutter Row negative
          inline margins, which made this block sit 6px wider on each side than
          the tiles above it. Full width now that the log has its own page, so
          the two line up. */}
      <GpuChart latest={gpus} />

      {/* Two views of the same thing at two time scales: what one request is
          doing right now, and what every request has done against how deep it
          started. Side by side because the second explains the first -- a live
          curve sitting at 5 t/s only reads as slow once the scatter shows the
          same box doing 12 at a quarter of the depth. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' }}>
        <div style={{ flex: '1 1 420px', minWidth: 0 }}>
          <Card
            title={<span style={{ fontSize: 12, opacity: 0.75 }}>請求進度</span>}
            size="small"
            style={{ height: '100%' }}
          >
            <RequestCurve traces={traces} />
          </Card>
        </div>
        <div style={{ flex: '1 1 420px', minWidth: 0 }}>
          <Card
            title={<span style={{ fontSize: 12, opacity: 0.75 }}>速率 vs context 深度</span>}
            size="small"
            style={{ height: '100%' }}
          >
            <DepthCurve models={models} ctxSize={runningCtx} />
          </Card>
        </div>
      </div>

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
                  // Configured size while stopped; live occupancy once running.
                  // The fullest slot is the one shown: it is the one about to
                  // truncate, and a truncated tool call is what kills a coding
                  // session outright.
                  title: 'CONTEXT', dataIndex: 'ctx_size', width: 132,
                  render: (n: number | null | undefined, row) => {
                    const slots = row.slots;
                    if (!slots?.length) {
                      return (
                        <Text style={{ fontSize: 11, fontFamily: MONO }}>
                          {n ? `${Math.round(n / 1024)}K` : '—'}
                        </Text>
                      );
                    }
                    const worst = slots.reduce((a, b) => (b.used > a.used ? b : a));
                    const percent = Math.min(100, (worst.used / worst.n_ctx) * 100);
                    // Amber matches the chat panel's own threshold; red is a
                    // step past it because the last few percent is where a
                    // reply gets cut in half rather than merely gets tight.
                    const colour = percent > 95 ? ACCENT.error
                      : percent > 85 ? ACCENT.warn : 'rgba(255,255,255,0.75)';
                    return (
                      <Tooltip title={slots.map((slot) =>
                        `slot ${slot.id}: ${slot.used.toLocaleString()} / ${slot.n_ctx.toLocaleString()}`
                        + `${slot.busy ? ' ・ 使用中' : ''}`).join('\n')}>
                        <div>
                          <div style={{
                            display: 'flex', justifyContent: 'space-between',
                            gap: 6, marginBottom: 3,
                          }}>
                            <Text style={{ fontSize: 11, fontFamily: MONO, color: colour }}>
                              {percent.toFixed(0)}%
                            </Text>
                            <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.45 }}>
                              {Math.round(worst.n_ctx / 1024)}K
                              {slots.length > 1 ? ` ×${slots.length}` : ''}
                            </Text>
                          </div>
                          <div className="meter">
                            <div style={{
                              height: '100%', width: `${percent}%`, borderRadius: 1,
                              background: colour, transition: 'width 300ms',
                            }} />
                          </div>
                        </div>
                      </Tooltip>
                    );
                  },
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


    </div>
  );
}
