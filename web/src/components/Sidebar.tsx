import { useEffect, useState } from 'react';
import { Layout, Menu, Tooltip, Typography } from 'antd';
import {
  ApiOutlined, AppstoreOutlined, CloudDownloadOutlined, ContainerOutlined,
  DashboardOutlined, DeploymentUnitOutlined, FileTextOutlined, FolderOpenOutlined, InfoCircleOutlined,
  MessageOutlined, PictureOutlined, SettingOutlined, TeamOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { Link, useLocation } from 'react-router-dom';
import {
  fetchConsoleVersion, fetchRelease, type GpuSample, type ModelInfo, type SystemSample,
} from '../api';
import { ACCENT, LINE, MONO } from '../theme';
import { deviceTag } from '../hardware';

const { Sider } = Layout;
const { Text } = Typography;

export const SIDEBAR_WIDTH = 208;
export const SIDEBAR_COLLAPSED = 64;

/** Grouped by what the user is doing, not by which service implements it. */
export const NAV_GROUPS = [
  {
    label: '使用',
    items: [
      { key: '/', icon: <DashboardOutlined />, label: '總覽' },
      { key: '/chat', icon: <MessageOutlined />, label: '對話' },
      { key: '/comfyui', icon: <PictureOutlined />, label: 'ComfyUI' },
      { key: '/files', icon: <FolderOpenOutlined />, label: '檔案' },
    ],
  },
  {
    label: '管理',
    items: [
      { key: '/models', icon: <AppstoreOutlined />, label: '模型' },
      { key: '/catalog', icon: <CloudDownloadOutlined />, label: '模型目錄' },
      { key: '/engines', icon: <DeploymentUnitOutlined />, label: '推論引擎' },
      { key: '/gpu', icon: <ThunderboltOutlined />, label: '顯示卡' },
      { key: '/runtime', icon: <ContainerOutlined />, label: '執行環境' },
      { key: '/connections', icon: <ApiOutlined />, label: '連線' },
      { key: '/logs', icon: <FileTextOutlined />, label: '日誌' },
      { key: '/users', icon: <TeamOutlined />, label: '使用者' },
      { key: '/settings', icon: <SettingOutlined />, label: '設定' },
      { key: '/about', icon: <InfoCircleOutlined />, label: '關於' },
    ],
  },
];

interface Props {
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  gpus: GpuSample[];
  models: ModelInfo[];
  system: SystemSample | null;
}

/** A one-line bar, drawn rather than componentised, so the footer stays dense. */
function Meter({ label, value, percent, warn }: {
  label: string; value: string; percent: number; warn?: boolean;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <Text style={{ fontSize: 10, opacity: 0.5, letterSpacing: 0.4 }}>{label}</Text>
        <Text style={{ fontSize: 10, fontFamily: MONO, opacity: 0.8 }}>{value}</Text>
      </div>
      <div className="meter">
        <div style={{
          height: '100%', width: `${Math.min(100, percent)}%`, borderRadius: 1,
          background: warn ? '#e0a83c' : 'rgba(255,255,255,0.7)',
          transition: 'width 400ms ease',
        }} />
      </div>
    </div>
  );
}

export default function Sidebar({ collapsed, onCollapse, gpus, models, system }: Props) {
  const [version, setVersion] = useState('');
  const [newer, setNewer] = useState<string | null>(null);
  useEffect(() => {
    // Once, and from the endpoint that only answers this. The full version
    // report probes every moving part on the machine, which is two thirds of a
    // second of subprocesses to render five characters that cannot change while
    // the process runs.
    fetchConsoleVersion().then(setVersion).catch(() => undefined);
    // Whether GitHub has a newer one, from the backend's cache: the mark
    // beside the version is how an installation learns of a release.
    const ask = () => fetchRelease().then((r) => setNewer(r.newer && r.latest ? r.latest : null)).catch(() => undefined);
    void ask();
    const timer = setInterval(ask, 6 * 3600 * 1000);
    return () => clearInterval(timer);
  }, []);

  const location = useLocation();
  const loaded = models.filter((m) => m.running);
  const busy = gpus.some((g) => g.busy);

  return (
    <Sider
      collapsible
      collapsed={collapsed}
      onCollapse={onCollapse}
      width={SIDEBAR_WIDTH}
      collapsedWidth={SIDEBAR_COLLAPSED}
      // Fixed, not sticky: the nav is a frame around the page, and scrolling a
      // long model list should never move it.
      style={{
        position: 'fixed', insetInlineStart: 0, top: 0, bottom: 0,
        height: '100vh', overflow: 'hidden',
        borderInlineEnd: `1px solid ${LINE.faint}`,
      }}
      // The column has to be declared on the body, not on the Sider. antd wraps
      // children in its own `-children` div, so a flex context on the Sider
      // applies to that wrapper and the trigger -- not to anything below. With
      // it in the wrong place the nav's `flex: 1` matched nothing, everything
      // stacked from the top, and the readings sat in the middle of the panel
      // above a void the height of the unused space.
      styles={{ body: { height: '100%', display: 'flex', flexDirection: 'column' } }}
    >
      <Link
        to="/"
        style={{
          display: 'flex', alignItems: 'center', gap: 10, height: 56,
          padding: collapsed ? '0 0 0 21px' : '0 16px', color: 'inherit',
          borderBottom: `1px solid ${LINE.faint}`, flexShrink: 0,
        }}
      >
        <Tooltip title={busy ? 'GPU 運算中' : 'GPU 閒置'} placement="right">
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: busy ? '#5ccf8f' : LINE.strong,
            boxShadow: busy ? '0 0 8px rgba(92,207,143,0.8)' : 'none',
            transition: 'background 300ms, box-shadow 300ms',
          }} />
        </Tooltip>
        {!collapsed && (
          /* Served from the console rather than linked to the CDN it came from:
             this is the frame's own chrome, and a header that breaks when the
             machine is off the internet -- which is a normal state for a box
             whose whole point is running locally -- is worse than 40 KB.
             The alt text is the fallback, so a missing file leaves a name
             rather than a gap. */
          <img
            src="/logo.webp"
            alt="TenkStack"
            /* The file carries transparent padding, so only 83% of this height
               is ink -- 36 here reads as about 30. Width follows at 3.83:1,
               which is 138 of the 159px the header has once the status dot and
               its gap are taken out, and leaves 10px above and below inside a
               56px header. 40 is the hard ceiling, coming within 6px of the
               padding, which stops reading as a margin. */
            style={{ height: 36, width: 'auto', display: 'block' }}
          />
        )}
      </Link>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingTop: 8 }}>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          style={{ borderInlineEnd: 0, background: 'transparent' }}
          items={NAV_GROUPS.map((group) => ({
            key: group.label,
            type: 'group' as const,
            label: collapsed ? undefined : (
              <span style={{ fontSize: 10, letterSpacing: 1.2, opacity: 0.4 }}>
                {group.label.toUpperCase()}
              </span>
            ),
            children: group.items.map((item) => ({
              key: item.key,
              icon: item.icon,
              label: <Link to={item.key}>{item.label}</Link>,
            })),
          }))}
        />
      </div>

      {!collapsed && (
        <div style={{
          padding: '12px 16px 2px', borderTop: `1px solid ${LINE.faint}`, flexShrink: 0,
        }}>
          {/*
            One bar per card, and only memory.

            This strip answers one question -- is anything full -- and that is a
            memory question. It carried a power bar too, summed across every
            card, which was the least informative form of a figure that did not
            belong here anyway: a card sitting at its cap is working normally,
            not filling up, and 200W against a 400W total could be one card at
            full tilt or two at half. Whether anything is busy is already
            answered by the dot at the top of this panel, and the exact wattage
            by the dashboard and its chart.

            Memory earns its place because it is the one that decides something:
            whether the next model fits, and whether ComfyUI is still holding
            the card.
          */}
          {/* Host memory first, then each card's.
              Above rather than below because a model that will not fit is a
              VRAM problem, but a machine that has started swapping makes
              everything slow at once -- including the loads that are about to
              fill those VRAM bars. The order is the order they go wrong in. */}
          {system?.memory && (
            <Meter
              label="RAM"
              value={`${(system.memory.used_bytes / 1024 ** 3).toFixed(1)}G`}
              percent={system.memory.percent}
              warn={system.memory.percent > 90}
            />
          )}
          {gpus.map((g) => {
            const pc = g.memory_total_mib
              ? ((g.memory_used_mib ?? 0) / g.memory_total_mib) * 100 : 0;
            return (
              <Meter
                key={g.index}
                // Named the way every other surface names a card, rather than
                // by a bare index that says nothing about which vendor it is.
                label={gpus.length > 1 ? `VRAM ${deviceTag(g.vendor, g.index)}` : 'VRAM'}
                value={`${((g.memory_used_mib ?? 0) / 1024).toFixed(1)}G`}
                percent={pc}
                warn={pc > 92}
              />
            );
          })}
          <Text style={{ fontSize: 10, opacity: 0.45, fontFamily: MONO }}>
            {loaded.length ? `${loaded.length} MODEL LOADED` : 'NO MODEL'}
          </Text>
        </div>
      )}

      {/* Nothing is reserved under this. The trigger is fixed over the bottom
          of the Sider, but antd already leaves the room for it -- its
          `-has-trigger` class puts `padding-bottom: triggerHeight` on the Sider
          itself, so the children box ends exactly where the trigger begins.
          Adding a margin here reserved the same 48px a second time, which is
          the gap that kept this from reaching the floor. */}
      <Tooltip title={newer ? `有新版 v${newer}，到「關於」更新` : `建置 ${__BUILD__}`} placement="right">
        <Link to="/about" style={{
          flexShrink: 0, paddingBottom: 4, display: 'flex', justifyContent: 'center',
          alignItems: 'center', gap: 6, lineHeight: 1, textDecoration: 'none',
        }}>
          <Text style={{
            fontSize: 10, opacity: newer ? 0.7 : 0.3, fontFamily: MONO, letterSpacing: 0.6,
          }}>
            {/* From the API, not from a build-time copy of package.json.
                That copy was the version's third home and it broke the moment
                the copy was deleted: `v${undefined}` is the literal string
                vundefined, printed here in place of a number. */}
            {version ? `v${version}` : ''}
          </Text>
          {newer && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT.warn, display: 'inline-block' }} />
          )}
        </Link>
      </Tooltip>
    </Sider>
  );
}
