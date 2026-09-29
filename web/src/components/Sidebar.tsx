import { useEffect, useState } from 'react';
import { Avatar, Badge, Dropdown, Layout, Menu, Tooltip, Typography } from 'antd';
import {
  ApiOutlined, AppstoreOutlined, CloudDownloadOutlined,
  DashboardOutlined, DeploymentUnitOutlined, FileTextOutlined, FolderOpenOutlined, InfoCircleOutlined,
  MessageOutlined, PictureOutlined, PoweroffOutlined,
  SettingOutlined, TeamOutlined, ThunderboltOutlined, UserOutlined, WarningFilled,
} from '@ant-design/icons';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  fetchConsoleVersion, fetchRelease, type AuthState, type GpuSample, type ModelInfo, type SystemSample,
} from '../api';
import { ACCENT, LINE, MONO, SURFACE } from '../theme';
import { deviceTag } from '../hardware';
import { useMedia } from '../media';

const { Sider } = Layout;
const { Text } = Typography;

export const SIDEBAR_WIDTH = 208;
export const SIDEBAR_COLLAPSED = 64;
/** Below this the sidebar is a drawer: fixed at 208 px it left a phone 176 px
 *  of page, and every page scrolled sideways. */
export const NARROW_BELOW = 768;

/** How the sidebar folds, which the page beside it follows step for step:
 *  antd's Sider animates its width over this, so the content's margin does
 *  the same, or the two drift apart mid-fold. */
export const SIDER_MOTION = '0.2s ease';

/**
 * What folding hides is faded, never removed. Taking an element out while the
 * width animates moved everything after it -- the group headings going took
 * every menu item up by their height, the logo going moved the status dot --
 * and the fold jerked. Kept in place, it is clipped by the narrowing sidebar
 * and simply fades.
 */
const fade = (hidden: boolean): React.CSSProperties => ({
  opacity: hidden ? 0 : 1, transition: 'opacity 0.15s', whiteSpace: 'nowrap',
  pointerEvents: hidden ? 'none' : undefined,
});

/** Whether the window is narrower than the sidebar can stand beside. */
export const useNarrow = () => useMedia(`(max-width: ${NARROW_BELOW - 1}px)`);

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
  /** Rendered inside the small-screen drawer: in the flow, never collapsed,
   *  and closing it when a page is picked. */
  drawer?: boolean;
  onNavigate?: () => void;
  gpus: GpuSample[];
  models: ModelInfo[];
  system: SystemSample | null;
  auth: AuthState;
  onSignOut: () => void;
}

/**
 * Who is signed in, at the sidebar's foot. The account used to be a button in
 * the page header, apart from everything else about the session; the fold
 * that was antd's bare chevron here is now a button in the header, beside
 * the page's name.
 */
function Footer({ auth, onSignOut, collapsed }: {
  auth: AuthState; onSignOut: () => void; collapsed: boolean;
}) {
  const navigate = useNavigate();
  const me = auth.identity;
  const role = me?.role === 'admin' ? '管理員' : '成員';

  const account = me ? (
    <Dropdown
      trigger={['click']}
      placement="topLeft"
      menu={{
        items: [
          { key: 'who', disabled: true, label: <span>{me.username}・{role}</span> },
          { type: 'divider' },
          { key: 'account', icon: <UserOutlined />, label: '帳號與金鑰' },
          { key: 'logout', icon: <PoweroffOutlined />, label: '登出', danger: true },
        ],
        onClick: ({ key }) => {
          if (key === 'account') navigate('/users');
          if (key === 'logout') onSignOut();
        },
      }}
    >
      <button type="button" className="sider-account" aria-label={`帳號：${me.username}`} style={{
        display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1, overflow: 'hidden',
        padding: '4px 8px', border: 0, borderRadius: 6, cursor: 'pointer',
        color: 'inherit', font: 'inherit', textAlign: 'left',
      }}>
        <Avatar size={28} style={{ background: LINE.soft, color: 'inherit', fontSize: 13, flex: 'none' }}>
          {me.username.slice(0, 1).toUpperCase()}
        </Avatar>
        <span style={{ minWidth: 0, lineHeight: 1.25, ...fade(collapsed) }}>
          <span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {me.username}
          </span>
          <Text type="secondary" style={{ fontSize: 11 }}>{role}</Text>
        </span>
      </button>
    </Dropdown>
  ) : (
    <Tooltip title="還沒有任何帳號，誰都能用；到「使用者」建立第一個帳號後就會開始要求登入" placement="right">
      <Link to="/users" style={{
        display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, overflow: 'hidden',
        padding: '4px 8px 4px 16px', color: ACCENT.warn, fontSize: 12,
      }}>
        <WarningFilled />
        <span style={fade(collapsed)}>未啟用驗證</span>
      </Link>
    </Tooltip>
  );

  return (
    <div style={{
      flexShrink: 0, borderTop: `1px solid ${LINE.faint}`, padding: 8,
      display: 'flex', alignItems: 'center',
    }}>
      {account}
    </div>
  );
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

export default function Sidebar({
  collapsed: collapsedProp, onCollapse, gpus, models, system, drawer, onNavigate, auth, onSignOut,
}: Props) {
  const collapsed = drawer ? false : collapsedProp;
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
      collapsible={!drawer}
      collapsed={collapsed}
      onCollapse={onCollapse}
      // The fold is a button in the page header, beside the page's name.
      trigger={null}
      width={SIDEBAR_WIDTH}
      collapsedWidth={SIDEBAR_COLLAPSED}
      // Fixed, not sticky: the nav is a frame around the page, and scrolling a
      // long model list should never move it. In the drawer it is the drawer.
      style={drawer ? { height: '100%', overflow: 'hidden' } : {
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
          // One padding in both states, so the status dot stays put while the
          // logo beside it fades. 28 px centres the 7 px dot in the folded
          // sidebar: 64 wide, less its 1 px border, is 63, and (63 - 7) / 2 = 28.
          padding: `0 0 0 ${(SIDEBAR_COLLAPSED - 1 - 7) / 2}px`, color: 'inherit', overflow: 'hidden',
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
        {/* Served from the console rather than linked to the CDN it came from:
           this is the frame's own chrome, and a header that breaks when the
           machine is off the internet -- which is a normal state for a box
           whose whole point is running locally -- is worse than 40 KB.
           The alt text is the fallback, so a missing file leaves a name
           rather than a gap. */}
        <img
          src="/logo.webp"
          alt="TenkStack"
          /* The file carries transparent padding, so only 83% of this height
             is ink -- 36 here reads as about 30. Width follows at 3.83:1,
             which is 138 of the 159px the header has once the status dot and
             its gap are taken out, and leaves 10px above and below inside a
             56px header. 40 is the hard ceiling, coming within 6px of the
             padding, which stops reading as a margin. */
          style={{ height: 36, width: 'auto', display: 'block', flexShrink: 0, ...fade(collapsed) }}
        />
      </Link>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingTop: 8 }}>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          onClick={() => onNavigate?.()}
          style={{ borderInlineEnd: 0, background: 'transparent' }}
          items={NAV_GROUPS.map((group) => ({
            key: group.label,
            type: 'group' as const,
            // Always there, faded when folded: taking it away moved every item
            // under it up by its height, mid-animation.
            label: (
              <span style={{ fontSize: 10, letterSpacing: 1.2, ...fade(collapsed), opacity: collapsed ? 0 : 0.4 }}>
                {group.label.toUpperCase()}
              </span>
            ),
            children: group.items.map((item) => {
              // A release newer than this one is marked on 關於 itself, where
              // it is updated, as well as beside the version at the foot.
              const mark = item.key === '/about' && newer;
              const here = location.pathname === item.key;
              return {
                key: item.key,
                icon: mark && collapsed
                  ? <Badge dot color={ACCENT.warn} offset={[2, 2]}>{item.icon}</Badge>
                  : item.icon,
                label: (
                  <Link to={item.key} style={{ display: 'flex', alignItems: 'center' }}>
                    {item.label}
                    {mark && (
                      // Shaped like the small selects elsewhere -- 4px
                      // corners, a 1px line -- but yellow, and inert; filled
                      // while 關於 is the page on screen.
                      <span title={`有新版 v${newer}`} style={{
                        marginInlineStart: 'auto', display: 'inline-flex', alignItems: 'center',
                        height: 20, padding: '0 7px', borderRadius: 4,
                        border: `1px solid ${ACCENT.warn}`,
                        color: here ? SURFACE.page : ACCENT.warn,
                        background: here ? ACCENT.warn : `${ACCENT.warn}14`,
                        fontSize: 11, lineHeight: 1,
                      }}>
                        新版
                      </span>
                    )}
                  </Link>
                ),
              };
            }),
          }))}
        />
      </div>

      <div style={{
        padding: '12px 16px 2px', borderTop: `1px solid ${LINE.faint}`, flexShrink: 0,
        ...fade(collapsed),
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

      {/* Folded, 64 px does not hold a version such as v0.7.0-rc1 on one line;
          the number moves into the tooltip and only the new-release dot stays. */}
      <Tooltip title={newer
        ? `有新版 v${newer}，到「關於」更新`
        : collapsed && version ? `v${version}・建置 ${__BUILD__}` : `建置 ${__BUILD__}`} placement="right">
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
            {version && !collapsed ? `v${version}` : ''}
          </Text>
          {newer && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT.warn, display: 'inline-block' }} />
          )}
        </Link>
      </Tooltip>
      <Footer auth={auth} onSignOut={onSignOut} collapsed={collapsed} />
    </Sider>
  );
}
