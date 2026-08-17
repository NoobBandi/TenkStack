import { useEffect, useState } from 'react';
import { Alert, Card, Collapse, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import { fetchGpuDevices, type GpuDevice, type GpuSample } from '../api';
import { useStream } from '../stream';
import { deviceTag } from '../hardware';
import { ACCENT, LINE, MONO } from '../theme';
import VendorMark from '../components/VendorMark';

const { Text } = Typography;

/**
 * The cards in this machine, one row each.
 *
 * A row rather than a section, because the two things this page is asked --
 * what is each card doing, and what is each card -- are asked at very different
 * rates. The first is asked every time the page opens and about every card at
 * once; the second is asked occasionally and about one card. So the live
 * reading is the row and the specification is what the row opens to reveal.
 *
 * Rows also compare better than the cards side by side that were here before.
 * The readings sit at the same offsets on every row, so two figures line up
 * vertically and can be read against each other without moving your eye across
 * a gap between two boxes.
 */

const VENDOR_COLOUR: Record<string, string> = {
  intel: 'blue', nvidia: 'green', amd: 'red',
};

/** One live figure in a row header. Fixed width so the columns line up between
 *  rows -- which is the whole reason these are rows. */
function Reading({ label, value, unit, title, width = 78 }: {
  label: string; value: string; unit?: string; title?: string; width?: number;
}) {
  const body = (
    <div style={{ width, flex: 'none' }}>
      <div style={{ fontSize: 9, letterSpacing: 1, opacity: 0.35 }}>{label}</div>
      <div style={{
        fontFamily: MONO, fontSize: 14, lineHeight: 1.3,
        // Tabular figures: these update every two seconds, and proportional
        // digits would shift the unit beside them on every sample.
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
        {unit && <span style={{ fontSize: 10, opacity: 0.45, marginLeft: 2 }}>{unit}</span>}
      </div>
    </div>
  );
  return title ? <Tooltip title={title}>{body}</Tooltip> : body;
}

/** The row itself: what the card is, and what it is doing, on one line. */
function Header({ device, live }: { device: GpuDevice; live: GpuSample | null }) {
  const usedGiB = (live?.memory_used_mib ?? 0) / 1024;
  const totalGiB = (live?.memory_total_mib ?? 0) / 1024;
  const percent = totalGiB ? (usedGiB / totalGiB) * 100 : 0;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', minWidth: 0,
    }}>
      <Space size={9} style={{ flex: '1 1 240px', minWidth: 0 }}>
        <Tooltip title={live?.busy ? '運算中' : '閒置'}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flex: 'none',
            background: live?.busy ? ACCENT.ok : LINE.strong,
            boxShadow: live?.busy ? `0 0 8px ${ACCENT.ok}b3` : 'none',
            display: 'inline-block', transition: 'background 300ms, box-shadow 300ms',
          }} />
        </Tooltip>
        <VendorMark vendor={device.vendor} size={15} style={{ opacity: 0.8 }} />
        <Text style={{ fontSize: 12 }} ellipsis>{device.name}</Text>
        <Tag color={VENDOR_COLOUR[device.vendor]}
             style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>
          {deviceTag(device.vendor, device.index)}
        </Tag>
      </Space>

      {/* Memory gets the bar because it is the one that decides something:
          whether the next model fits. The rest are numbers. */}
      <div style={{ width: 150, flex: 'none' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', fontSize: 9,
          letterSpacing: 1, opacity: 0.35, marginBottom: 1,
        }}>
          <span>VRAM</span>
          <span style={{ fontFamily: MONO, letterSpacing: 0, opacity: 0.9 }}>
            {usedGiB.toFixed(1)} / {totalGiB.toFixed(0)} GiB
          </span>
        </div>
        <div style={{ height: 3, background: LINE.faint, borderRadius: 2 }}>
          <div style={{
            height: '100%', width: `${Math.min(100, percent)}%`, borderRadius: 2,
            background: percent > 92 ? ACCENT.warn : 'rgba(255,255,255,0.8)',
            transition: 'width 400ms ease',
          }} />
        </div>
      </div>

      <Reading
        label="POWER" value={(live?.power_w ?? 0).toFixed(0)} unit="W"
        title={live?.power_cap_w ? `上限 ${live.power_cap_w.toFixed(0)} W` : undefined}
      />
      <Reading
        label="CLOCK" value={(live?.frequency_mhz ?? 0).toFixed(0)} unit="MHz" width={88}
        title={live?.frequency_max_mhz ? `上限 ${live.frequency_max_mhz.toFixed(0)} MHz` : undefined}
      />
      <Reading
        label="TEMP"
        value={live?.temperature_c != null ? live.temperature_c.toFixed(0) : '—'}
        unit={live?.temperature_c != null ? '°C' : undefined}
        width={64}
        title={live?.temperature_c == null
          ? '這張卡的驅動沒有提供溫度感測器'
          : live.temperature_crit_c ? `臨界 ${live.temperature_crit_c.toFixed(0)} °C` : undefined}
      />
    </div>
  );
}

/** One card's specifications, packed rather than gridded. */
function Specs({ device }: { device: GpuDevice }) {
  if (device.groups.length === 0) {
    return <Empty description="驅動沒有回報詳細規格" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <>
      <Text style={{ fontSize: 10, opacity: 0.35, fontFamily: MONO, display: 'block', marginBottom: 10 }}>
        {[device.pci_bdf_address, device.drm_device].filter(Boolean).join(' ・ ')}
      </Text>
      {/* A column flow, not a row of columns. Five groups of unequal height
          across three columns leave a ragged hole wherever the tallest one
          lands; `columns` packs them by height instead. Taking a width rather
          than a count means it reflows on its own, with no breakpoints to keep
          in step. */}
      <div style={{ columns: '250px', columnGap: 14 }}>
        {device.groups.map((group) => (
          <Card
            key={group.title}
            size="small"
            title={<span style={{ fontSize: 11, opacity: 0.6 }}>{group.title}</span>}
            styles={{ body: { padding: '4px 12px 8px' } }}
            style={{ breakInside: 'avoid', marginBottom: 14 }}
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
    </>
  );
}

export default function Gpu() {
  const { gpus } = useStream();
  const [devices, setDevices] = useState<GpuDevice[] | null>(null);
  const [open, setOpen] = useState<string[]>([]);

  useEffect(() => {
    fetchGpuDevices()
      .then((found) => {
        setDevices(found);
        // Open, once, when the listing first arrives. Set here rather than as
        // an initial state because the devices are not known at mount, and set
        // only from this one fetch so that collapsing a row stays collapsed.
        setOpen(found.map((d) => String(d.index)));
      })
      .catch(() => setDevices([]));
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
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Open to begin with, and remembered once closed. A row's header holds
          the readings and its body the specifications, and with two cards the
          two bodies are not a wall -- hiding them by default would mean two
          clicks before the page has said anything it could not fit in a
          header. */}
      <Collapse
        activeKey={open}
        onChange={(keys) => setOpen(keys as string[])}
        items={devices.map((device) => ({
          key: String(device.index),
          label: <Header device={device} live={liveFor(device)} />,
          children: <Specs device={device} />,
          // The header is a row of live figures, and clicking anywhere on it to
          // expand is what makes it a row rather than a card with a control in
          // the corner.
          styles: { header: { alignItems: 'center' } },
        }))}
      />

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
