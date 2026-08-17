import { useEffect, useState } from 'react';
import { Alert, Card, Col, Empty, Progress, Row, Space, Tag, Typography } from 'antd';
import { fetchGpuDevices, type GpuDevice } from '../api';
import { useStream } from '../stream';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * What each vendor's own tooling calls a card.
 *
 * `xpu:0` and `cuda:0` are the strings that appear in ComfyUI's device list,
 * in torch, and in the llama.cpp device selector, so the tag matches what you
 * would type elsewhere rather than inventing a third naming scheme. Falls back
 * to the provider key so an unrecognised vendor is labelled rather than
 * mislabelled.
 */
const DEVICE_NAMESPACE: Record<string, string> = {
  intel: 'xpu', nvidia: 'cuda', amd: 'hip',
};

function Readout({ label, value, unit, note }: {
  label: string; value: string; unit?: string; note?: string;
}) {
  return (
    <div>
      <Text style={{ fontSize: 10, letterSpacing: 1, opacity: 0.45 }}>{label}</Text>
      <div style={{ fontFamily: MONO, fontSize: 24, lineHeight: 1.3 }}>
        {value}
        {unit && <span style={{ fontSize: 13, opacity: 0.5, marginLeft: 3 }}>{unit}</span>}
      </div>
      {note && <Text style={{ fontSize: 11, opacity: 0.4 }}>{note}</Text>}
    </div>
  );
}

export default function Gpu() {
  const { gpus } = useStream();
  const [devices, setDevices] = useState<GpuDevice[] | null>(null);

  useEffect(() => {
    fetchGpuDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  if (devices === null) return <Card size="small" loading />;
  if (devices.length === 0) {
    return (
      <Alert
        type="warning"
        showIcon
        message="偵測不到任何 GPU"
        description="需要對應廠商的工具：Intel 用 xpu-smi、NVIDIA 用 nvidia-smi、AMD 用 rocm-smi。若剛裝好驅動，請確認核心模組已載入。"
      />
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {devices.map((device) => {
        // The live sample from the stream is fresher than the one embedded in
        // the device listing, which is only fetched on mount. Matched per
        // device: comparing against a single stream sample left every card but
        // one frozen at whatever it read when the page opened.
        const live = gpus.find((g) => g.index === device.index) ?? device.live;
        const usedGiB = (live?.memory_used_mib ?? 0) / 1024;
        const totalGiB = (live?.memory_total_mib ?? 0) / 1024;
        const percent = totalGiB ? (usedGiB / totalGiB) * 100 : 0;

        return (
          <div key={device.index}>
            <Card
              size="small"
              title={
                <Space size={10}>
                  <span style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: live?.busy ? '#5ccf8f' : LINE.strong,
                    display: 'inline-block',
                  }} />
                  <span style={{ fontFamily: MONO, fontSize: 12 }}>{device.name}</span>
                  <Tag style={{ fontFamily: MONO, fontSize: 10 }}>
                    {DEVICE_NAMESPACE[device.vendor] ?? device.vendor}:{device.index}
                  </Tag>
                </Space>
              }
              extra={
                <Text style={{ fontSize: 11, opacity: 0.45, fontFamily: MONO }}>
                  {/* nvidia-smi reports no DRM node, so the separator would
                      otherwise trail into a null. */}
                  {[device.pci_bdf_address, device.drm_device].filter(Boolean).join(' ・ ')}
                </Text>
              }
            >
              <Row gutter={[24, 20]}>
                <Col xs={12} md={6}>
                  {/* No idle figure in the note. It used to read "約 46 W",
                      which is this Arc's idle draw and nobody else's -- the
                      3060 beside it idles at 10. A number that is only true
                      for one card is worse than no number. */}
                  <Readout label="POWER" value={(live?.power_w ?? 0).toFixed(0)} unit="W"
                           note={live?.busy ? '運算中' : '閒置'} />
                </Col>
                <Col xs={12} md={6}>
                  <Readout label="CLOCK" value={(live?.frequency_mhz ?? 0).toFixed(0)} unit="MHz"
                           note={live?.frequency_max_mhz
                             ? `上限 ${live.frequency_max_mhz.toFixed(0)} MHz`
                             : undefined} />
                </Col>
                <Col xs={12} md={6}>
                  <Readout label="VRAM" value={usedGiB.toFixed(1)}
                           unit={`/ ${totalGiB.toFixed(0)} GiB`}
                           note={`剩餘 ${(totalGiB - usedGiB).toFixed(1)} GiB`} />
                </Col>
                <Col xs={12} md={6}>
                  <Readout
                    label="TEMP"
                    value={live?.temperature_c != null ? live.temperature_c.toFixed(0) : '—'}
                    unit={live?.temperature_c != null ? '°C' : undefined}
                    // Stated rather than shown as zero: a card that exposes
                    // no temperature sensor would otherwise read as cold.
                    note={live?.temperature_c == null ? '驅動未提供此感測器' : undefined}
                  />
                </Col>
                <Col span={24}>
                  <Progress
                    percent={Math.round(percent)}
                    size="small"
                    strokeColor={percent > 92 ? '#e0a83c' : '#ffffff'}
                    trailColor="rgba(255,255,255,0.08)"
                    format={(p) => (
                      <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.6 }}>{p}%</Text>
                    )}
                  />
                </Col>
              </Row>
            </Card>

            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              {device.groups.map((group) => (
                <Col key={group.title} xs={24} md={12} xl={8}>
                  <Card
                    size="small"
                    title={<span style={{ fontSize: 12, opacity: 0.7 }}>{group.title}</span>}
                    style={{ height: '100%' }}
                  >
                    {group.rows.map((row) => (
                      <div
                        key={row.key}
                        style={{
                          display: 'flex', justifyContent: 'space-between', gap: 12,
                          padding: '5px 0', borderBottom: `1px solid ${LINE.faint}`,
                        }}
                      >
                        <Text style={{ fontSize: 12, opacity: 0.55, whiteSpace: 'nowrap' }}>
                          {row.label}
                        </Text>
                        <Text style={{
                          fontSize: 12, fontFamily: MONO, textAlign: 'right',
                          wordBreak: 'break-all',
                        }}>
                          {row.value}
                        </Text>
                      </div>
                    ))}
                  </Card>
                </Col>
              ))}
            </Row>

            {device.groups.length === 0 && (
              <Empty description="驅動沒有回報詳細規格" style={{ marginTop: 16 }} />
            )}
          </div>
        );
      })}

      {/* Only where it applies. This describes xpu-smi's sentinel values and
          nothing else's, and on a machine with an NVIDIA card beside the Arc it
          would otherwise read as a statement about both. */}
      {devices.some((d) => d.vendor === 'intel') && (
        <Alert
          type="info"
          showIcon
          message="Intel 卡有部分欄位不會顯示"
          description="xpu-smi 對它不追蹤的項目會回傳哨兵值（未知匯流排寬度回報為 4294967295、未追蹤的可用記憶體回報為 0）。那些欄位在這裡被略過而不是照樣顯示——錯的數字比空白更糟。"
        />
      )}
    </Space>
  );
}
