import { useEffect, useState } from 'react';
import { Alert, Card, Empty, Progress, Space, Tag, Tooltip, Typography } from 'antd';
import { fetchGpuDevices, type GpuDevice, type GpuSample } from '../api';
import { useStream } from '../stream';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * The cards in this machine.
 *
 * Two halves, because the page answers two different questions and they want
 * opposite shapes. "What is happening right now" is a comparison -- every card
 * side by side, small enough to take in at once. "What is this card" is a
 * reference, read one at a time and only when something is being looked up.
 *
 * Before there were two GPUs this was a column of 24px readouts followed by a
 * ragged grid of spec cards, repeated per device. With a second card in the
 * machine that became two screens of scrolling to compare two numbers.
 */

/**
 * What each vendor's own tooling calls a card.
 *
 * `xpu:0` and `cuda:0` are the strings that appear in ComfyUI's device list, in
 * torch, and in the llama.cpp device selector, so the tag matches what you
 * would type elsewhere rather than inventing a third naming scheme. Falls back
 * to the provider key so an unrecognised vendor is labelled, not mislabelled.
 */
const DEVICE_NAMESPACE: Record<string, string> = {
  intel: 'xpu', nvidia: 'cuda', amd: 'hip',
};

const VENDOR_COLOUR: Record<string, string> = {
  intel: 'blue', nvidia: 'green', amd: 'red',
};

function Readout({ label, value, unit, note }: {
  label: string; value: string; unit?: string; note?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <Text style={{ fontSize: 10, letterSpacing: 1, opacity: 0.4 }}>{label}</Text>
      <div style={{ fontFamily: MONO, fontSize: 21, lineHeight: 1.25 }}>
        {value}
        {unit && <span style={{ fontSize: 12, opacity: 0.45, marginLeft: 3 }}>{unit}</span>}
      </div>
      {/* A blank line rather than none, so a card whose driver reports a
          ceiling and one whose driver does not still line up. */}
      <Text style={{ fontSize: 10, opacity: 0.35 }}>{note ?? ' '}</Text>
    </div>
  );
}

/** One card's live state: the whole of the top half, for one GPU. */
function LivePanel({ device, live }: { device: GpuDevice; live: GpuSample | null }) {
  const usedGiB = (live?.memory_used_mib ?? 0) / 1024;
  const totalGiB = (live?.memory_total_mib ?? 0) / 1024;
  const percent = totalGiB ? (usedGiB / totalGiB) * 100 : 0;
  const namespace = DEVICE_NAMESPACE[device.vendor] ?? device.vendor;

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      styles={{ body: { padding: '14px 16px 8px' } }}
      title={
        <Space size={9}>
          <Tooltip title={live?.busy ? '運算中' : '閒置'}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: live?.busy ? '#5ccf8f' : LINE.strong,
              boxShadow: live?.busy ? '0 0 8px rgba(92,207,143,0.7)' : 'none',
              display: 'inline-block', transition: 'background 300ms, box-shadow 300ms',
            }} />
          </Tooltip>
          <Text style={{ fontSize: 12 }} ellipsis>{device.name}</Text>
          <Tag color={VENDOR_COLOUR[device.vendor]}
               style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>
            {namespace}:{device.index}
          </Tag>
        </Space>
      }
      extra={
        <Text style={{ fontSize: 10, opacity: 0.4, fontFamily: MONO }}>
          {/* nvidia-smi reports no DRM node, so the separator would otherwise
              trail into a null. */}
          {[device.pci_bdf_address, device.drm_device].filter(Boolean).join(' ・ ')}
        </Text>
      }
    >
      {/* auto-fit rather than four fixed columns: this panel is half the page
          on a wide screen and all of it on a laptop, and the readouts should
          reflow rather than crush. */}
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
      }}>
        <Readout
          label="POWER" value={(live?.power_w ?? 0).toFixed(0)} unit="W"
          note={live?.power_cap_w ? `上限 ${live.power_cap_w.toFixed(0)} W` : undefined}
        />
        <Readout
          label="CLOCK" value={(live?.frequency_mhz ?? 0).toFixed(0)} unit="MHz"
          note={live?.frequency_max_mhz ? `上限 ${live.frequency_max_mhz.toFixed(0)}` : undefined}
        />
        <Readout
          label="VRAM" value={usedGiB.toFixed(1)} unit={`/ ${totalGiB.toFixed(0)} GiB`}
          note={`剩 ${(totalGiB - usedGiB).toFixed(1)} GiB`}
        />
        <Readout
          label="TEMP"
          value={live?.temperature_c != null ? live.temperature_c.toFixed(0) : '—'}
          unit={live?.temperature_c != null ? '°C' : undefined}
          // Stated rather than shown as zero: a card that exposes no
          // temperature sensor would otherwise read as cold.
          note={live?.temperature_c == null ? '無感測器' : undefined}
        />
      </div>

      <Progress
        percent={Math.round(percent)}
        size="small"
        strokeColor={percent > 92 ? '#e0a83c' : 'rgba(255,255,255,0.75)'}
        trailColor="rgba(255,255,255,0.07)"
        style={{ marginTop: 6, marginBottom: 0 }}
        format={(p) => (
          <Text style={{ fontSize: 10, fontFamily: MONO, opacity: 0.5 }}>{p}%</Text>
        )}
      />
    </Card>
  );
}

/** One card's specifications, packed rather than gridded. */
function Specs({ device }: { device: GpuDevice }) {
  if (device.groups.length === 0) {
    return <Empty description="驅動沒有回報詳細規格" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    // A column flow, not a Row of Cols. Five groups of unequal height across
    // three columns leave a ragged hole wherever the tallest one lands;
    // `columns` packs them by height instead. Taking a width rather than a
    // count means it reflows on its own, with no breakpoints to keep in step.
    <div style={{ columns: '260px', columnGap: 16 }}>
      {device.groups.map((group) => (
        <Card
          key={group.title}
          size="small"
          title={<span style={{ fontSize: 11, opacity: 0.6 }}>{group.title}</span>}
          styles={{ body: { padding: '4px 12px 8px' } }}
          style={{ breakInside: 'avoid', marginBottom: 16 }}
        >
          {group.rows.map((row) => (
            <div
              key={row.key}
              style={{
                display: 'flex', justifyContent: 'space-between', gap: 12,
                padding: '4px 0', borderBottom: `1px solid ${LINE.faint}`,
              }}
            >
              <Text style={{ fontSize: 11, opacity: 0.5, whiteSpace: 'nowrap' }}>
                {row.label}
              </Text>
              <Text style={{
                fontSize: 11, fontFamily: MONO, textAlign: 'right', wordBreak: 'break-all',
              }}>
                {row.value}
              </Text>
            </div>
          ))}
        </Card>
      ))}
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

  // The stream's sample is fresher than the one embedded in the listing, which
  // is fetched once on mount. Matched per device: comparing against a single
  // stream sample left every card but one frozen at whatever it read when the
  // page opened.
  const liveFor = (device: GpuDevice) =>
    gpus.find((g) => g.index === device.index) ?? device.live;

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      {/* Every card at once, side by side where there is room. Two cards get
          compared far more often than either gets read alone. */}
      <div style={{
        display: 'grid', gap: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
      }}>
        {devices.map((device) => (
          <LivePanel key={device.index} device={device} live={liveFor(device)} />
        ))}
      </div>

      {devices.map((device) => (
        <div key={device.index}>
          {/* Only worth a heading when there is more than one card to tell
              apart; with one, the panel above has already said which. */}
          {devices.length > 1 && (
            <Text style={{
              fontSize: 11, opacity: 0.45, display: 'block', marginBottom: 8,
              letterSpacing: 0.5, fontFamily: MONO,
            }}>
              {DEVICE_NAMESPACE[device.vendor] ?? device.vendor}:{device.index} ・ {device.name}
            </Text>
          )}
          <Specs device={device} />
        </div>
      ))}

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
