import { useEffect, useState } from 'react';
import { Alert, Card, Collapse, Space, Tag, Tooltip, Typography } from 'antd';
import {
  fetchGpuDevices, fetchGpuOccupants, fetchOrphanedContainers,
  type GpuDevice, type GpuOccupant, type GpuSample, type RuntimeContainer,
} from '../api';
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
      {/* A flex row rather than a Space: Space's items do not shrink, so on a
          phone the name ran under the memory bar beside it instead of
          ending in an ellipsis. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: '1 1 220px', minWidth: 0 }}>
        <Tooltip title={live?.busy ? '運算中' : '閒置'}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flex: 'none',
            background: live?.busy ? ACCENT.ok : LINE.strong,
            boxShadow: live?.busy ? `0 0 8px ${ACCENT.ok}b3` : 'none',
            display: 'inline-block', transition: 'background 300ms, box-shadow 300ms',
          }} />
        </Tooltip>
        {/* 18 against the 12px name beside it. The mark is the fastest thing
            to recognise in the row, so it leads rather than matches. */}
        <VendorMark vendor={device.vendor} size={18} style={{ opacity: 0.85 }} />
        <Text style={{ fontSize: 12, minWidth: 0 }} ellipsis>{device.name}</Text>
        <Tag color={VENDOR_COLOUR[device.vendor]}
             style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0, flex: 'none' }}>
          {deviceTag(device.vendor, device.index)}
        </Tag>
      </div>

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

/** What holds the card now: the answer to a card that looks full. */
function Occupants({ list }: { list: GpuOccupant[] | undefined }) {
  if (!list) return null;
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 14px',
      // Under the name, past the status dot and the vendor mark.
      paddingInlineStart: 34, marginTop: 6, fontSize: 12,
    }}>
      {list.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>沒有模型或容器在用這張卡</Text>}
      {list.map((o) => (
        <div key={`${o.kind}-${o.name}`} style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0,
        }}>
          <Tag color={o.kind === 'model' ? 'geekblue' : 'default'}
               style={{ fontSize: 11, marginInlineEnd: 0 }}>
            {o.kind === 'model' ? (o.engine ?? '模型') : '容器'}
          </Tag>
          <Text style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{o.name}</Text>
          <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            {[
              o.cards > 1 && `跨 ${o.cards} 張卡`,
              OCCUPANT_STATE[o.state] ?? o.state,
            ].filter(Boolean).join(' ・ ')}
          </Text>
        </div>
      ))}
    </div>
  );
}

const OCCUPANT_STATE: Record<string, string> = {
  ready: '已載入', starting: '載入中', stopping: '卸載中',
  running: '執行中', exited: '已停止', created: '已建立', paused: '已暫停', restarting: '重啟中',
};

/** One label and value, as the specification lists draw them. */
function SpecRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 12,
      padding: '4px 0', borderBottom: `1px solid ${LINE.faint}`,
    }}>
      <Text style={{ fontSize: 11, opacity: 0.5, whiteSpace: 'nowrap' }}>{label}</Text>
      <Text style={{ fontSize: 11, fontFamily: MONO, textAlign: 'right', wordBreak: 'break-all' }}>
        {children}
      </Text>
    </div>
  );
}

/**
 * One card's specifications: the few that decide something first, the rest
 * folded. The vendor tool reports twenty-odd fields -- slices, SIMD width,
 * firmware names -- and a page that opens on all of them buries the four a
 * person running models needs: how much memory, how it is connected, which
 * driver.
 */
function Specs({ device }: { device: GpuDevice }) {
  const field = (key: string) =>
    device.groups.flatMap((g) => g.rows).find((r) => r.key === key)?.value;
  const totalMiB = device.live?.memory_total_mib;
  const pcie = device.pcie;
  const rows: [string, React.ReactNode][] = [
    ['型號', device.name],
    ['顯存', totalMiB ? `${(totalMiB / 1024).toFixed(1)} GiB` : undefined],
    ['PCIe', pcie && (
      <Space size={6} wrap style={{ justifyContent: 'flex-end' }}>
        <span>{pcie.link}</span>
        {pcie.slot_limited && (
          <Tooltip title="卡片放在比它慢或窄的插槽上。單卡跑模型影響不大；多張卡一起跑同一個模型時，卡之間的資料都要走這條，速度會受限。">
            <Tag color="warning" style={{ marginInlineEnd: 0, fontFamily: 'inherit' }}>
              卡支援 {pcie.card.replace('PCIe ', '')}，受插槽限制
            </Tag>
          </Tooltip>
        )}
        {!!pcie.narrower_now && (
          <Tooltip title="實際接上的通道比插槽和卡都支援的少，常見原因是卡沒插緊，或這個插槽和其他裝置共用通道。">
            <Tag color="error" style={{ marginInlineEnd: 0, fontFamily: 'inherit' }}>
              目前只接上 x{pcie.narrower_now}
            </Tag>
          </Tooltip>
        )}
      </Space>
    )],
    ['驅動版本', field('driver_version')],
    ['核心版本', field('kernel_version')],
    ['PCI 位址', [device.pci_bdf_address, device.drm_device].filter(Boolean).join(' ・ ') || undefined],
  ];
  const summary = rows.filter(([, value]) => !!value);

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <div style={{ maxWidth: 560 }}>
        {summary.map(([label, value]) => <SpecRow key={label} label={label}>{value}</SpecRow>)}
      </div>
      {device.groups.length > 0 && (
        <Collapse
          ghost
          size="small"
          items={[{
            key: 'all',
            label: <Text type="secondary" style={{ fontSize: 12 }}>完整規格</Text>,
            children: (
              // A column flow, not a row of columns: groups of unequal height
              // across columns leave a ragged hole wherever the tallest one
              // lands; `columns` packs them by height instead.
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
                      <SpecRow key={row.key} label={row.label}>{row.value}</SpecRow>
                    ))}
                  </Card>
                ))}
              </div>
            ),
          }]}
        />
      )}
    </Space>
  );
}

export default function Gpu() {
  const { gpus } = useStream();
  const [devices, setDevices] = useState<GpuDevice[] | null>(null);
  const [open, setOpen] = useState<string[]>([]);
  const [orphaned, setOrphaned] = useState<RuntimeContainer[]>([]);
  const [occupants, setOccupants] = useState<Record<string, GpuOccupant[]> | null>(null);

  useEffect(() => {
    fetchOrphanedContainers().then(setOrphaned).catch(() => undefined);
  }, []);

  // Refreshed while the page is open: a model loading or unloading changes
  // the answer, and it is the one line here a reader acts on.
  useEffect(() => {
    const load = () => fetchGpuOccupants().then(setOccupants).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, []);

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
      {/* A container given a card that is no longer in the machine: docker
          keeps starting it, and nothing else says why it does nothing. */}
      {orphaned.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="有容器指定的顯示卡不在這台機器上"
          description={<>
            {orphaned.map((c) => c.name).join('、')}
            ：建立時指定的卡已經找不到（換過卡、或插槽位置變了），容器仍會啟動但用不到顯示卡。
            ComfyUI 的容器到 ComfyUI 頁重建即可。
          </>}
        />
      )}
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
          label: (
            <div>
              <Header device={device} live={liveFor(device)} />
              <Occupants list={occupants?.[device.pci_bdf_address]} />
            </div>
          ),
          children: <Specs device={device} />,
          // The header is a row of live figures, and clicking anywhere on it to
          // expand is what makes it a row rather than a card with a control in
          // the corner.
          styles: { header: { alignItems: 'center' } },
        }))}
      />

    </Space>
  );
}
