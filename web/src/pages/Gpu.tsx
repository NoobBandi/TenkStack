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
 * The cards in this machine, one tile each, as many to a row as fit.
 *
 * They were full-width rows, so that two cards' readings lined up for
 * comparison -- but a row has four numbers and a name, and on a wide screen
 * that left most of it empty. A tile holds what a row did and what it opened
 * to: what the card is doing, what is on it, how it is connected. The long
 * list the vendor tool reports stays folded under 完整規格.
 */

const VENDOR_COLOUR: Record<string, string> = {
  intel: 'blue', nvidia: 'green', amd: 'red',
};

const OCCUPANT_STATE: Record<string, string> = {
  ready: '已載入', starting: '載入中', stopping: '卸載中',
  running: '執行中', exited: '已停止', created: '已建立', paused: '已暫停', restarting: '重啟中',
};

/** A small heading inside a tile. */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, letterSpacing: 1, opacity: 0.4, marginBottom: 6 }}>{children}</div>
  );
}

/** One live figure. */
function Reading({ label, value, unit, title }: {
  label: string; value: string; unit?: string; title?: string;
}) {
  const body = (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 9, letterSpacing: 1, opacity: 0.35 }}>{label}</div>
      <div style={{
        fontFamily: MONO, fontSize: 16, lineHeight: 1.3,
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

/** The tile's title: the status dot, the vendor, the name. */
function Title({ device, live }: { device: GpuDevice; live: GpuSample | null }) {
  return (
    // A flex row rather than a Space: Space's items do not shrink, so a long
    // name ran under what sat beside it instead of ending in an ellipsis.
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
      <Tooltip title={live?.busy ? '運算中' : '閒置'}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flex: 'none',
          background: live?.busy ? ACCENT.ok : LINE.strong,
          boxShadow: live?.busy ? `0 0 8px ${ACCENT.ok}b3` : 'none',
          display: 'inline-block', transition: 'background 300ms, box-shadow 300ms',
        }} />
      </Tooltip>
      <VendorMark vendor={device.vendor} size={18} style={{ opacity: 0.85, flex: 'none' }} />
      <Text style={{ fontSize: 13, fontWeight: 400, minWidth: 0 }} ellipsis>{device.name}</Text>
    </div>
  );
}

/** Memory as a bar, since it decides whether the next model fits, and the
 *  rest as numbers. */
function Live({ live }: { live: GpuSample | null }) {
  const usedGiB = (live?.memory_used_mib ?? 0) / 1024;
  const totalGiB = (live?.memory_total_mib ?? 0) / 1024;
  const percent = totalGiB ? (usedGiB / totalGiB) * 100 : 0;
  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4,
      }}>
        <span style={{ fontSize: 9, letterSpacing: 1, opacity: 0.35 }}>VRAM</span>
        <span style={{ fontFamily: MONO, fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          {usedGiB.toFixed(1)}
          <span style={{ opacity: 0.45, fontSize: 11 }}> / {totalGiB.toFixed(0)} GiB</span>
        </span>
      </div>
      <div style={{ height: 4, background: LINE.faint, borderRadius: 2 }}>
        <div style={{
          height: '100%', width: `${Math.min(100, percent)}%`, borderRadius: 2,
          background: percent > 92 ? ACCENT.warn : 'rgba(255,255,255,0.8)',
          transition: 'width 400ms ease',
        }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 14 }}>
        <Reading
          label="POWER" value={(live?.power_w ?? 0).toFixed(0)} unit="W"
          title={live?.power_cap_w ? `上限 ${live.power_cap_w.toFixed(0)} W` : undefined}
        />
        <Reading
          label="CLOCK" value={(live?.frequency_mhz ?? 0).toFixed(0)} unit="MHz"
          title={live?.frequency_max_mhz ? `上限 ${live.frequency_max_mhz.toFixed(0)} MHz` : undefined}
        />
        <Reading
          label="TEMP"
          value={live?.temperature_c != null ? live.temperature_c.toFixed(0) : '—'}
          unit={live?.temperature_c != null ? '°C' : undefined}
          title={live?.temperature_c == null
            ? '這張卡的驅動沒有提供溫度感測器'
            : live.temperature_crit_c ? `臨界 ${live.temperature_crit_c.toFixed(0)} °C` : undefined}
        />
      </div>
    </div>
  );
}

/** What holds the card now: the answer to a card that looks full. */
function Occupants({ list }: { list: GpuOccupant[] | undefined }) {
  if (!list) return null;
  return (
    <div>
      <Label>正在使用</Label>
      {list.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>沒有模型或容器在用這張卡</Text>}
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
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
      </Space>
    </div>
  );
}

/** One label and value, as the specification lists draw them. */
function SpecRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
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
 * The few specifications that decide something -- how much memory, how it
 * is connected, which driver -- then the rest folded. The vendor tool reports
 * twenty-odd fields, slices and SIMD widths and firmware names, and a tile
 * that opens on all of them buries these.
 */
function Specs({ device }: { device: GpuDevice }) {
  const field = (key: string) =>
    device.groups.flatMap((g) => g.rows).find((r) => r.key === key)?.value;
  const totalMiB = device.live?.memory_total_mib;
  const pcie = device.pcie;
  const rows: [string, React.ReactNode][] = [
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
    <div>
      <Label>規格</Label>
      {summary.map(([label, value]) => <SpecRow key={label} label={label}>{value}</SpecRow>)}
      {device.groups.length > 0 && (
        <Collapse
          ghost
          size="small"
          style={{ marginTop: 4, marginInline: -8 }}
          items={[{
            key: 'all',
            label: <Text type="secondary" style={{ fontSize: 12 }}>完整規格</Text>,
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {device.groups.map((group) => (
                  <div key={group.title}>
                    <Text style={{ fontSize: 11, opacity: 0.6 }}>{group.title}</Text>
                    {group.rows.map((row) => (
                      <SpecRow key={row.key} label={row.label}>{row.value}</SpecRow>
                    ))}
                  </div>
                ))}
              </Space>
            ),
          }]}
        />
      )}
    </div>
  );
}

function Tile({ device, live, occupants }: {
  device: GpuDevice; live: GpuSample | null; occupants: GpuOccupant[] | undefined;
}) {
  return (
    <Card
      size="small"
      title={<Title device={device} live={live} />}
      extra={(
        <Tag color={VENDOR_COLOUR[device.vendor]}
             style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>
          {deviceTag(device.vendor, device.index)}
        </Tag>
      )}
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 18, padding: 16 } }}
    >
      <Live live={live} />
      <Occupants list={occupants} />
      <Specs device={device} />
    </Card>
  );
}

export default function Gpu() {
  const { gpus } = useStream();
  const [devices, setDevices] = useState<GpuDevice[] | null>(null);
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
      {/* auto-fill with a floor: as many tiles to a row as fit, each at
          least 360px, one column on a phone. Aligned to the top so opening
          one tile's full specification does not stretch its neighbour. */}
      <div style={{
        display: 'grid', gap: 16, alignItems: 'start',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))',
      }}>
        {devices.map((device) => (
          <Tile key={device.index} device={device} live={liveFor(device)}
                occupants={occupants?.[device.pci_bdf_address]} />
        ))}
      </div>
    </Space>
  );
}
