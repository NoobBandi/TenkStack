import { useCallback, useEffect, useState } from 'react';
import {
  App as AntApp, Button, ConfigProvider, Drawer, Dropdown, Layout, Space, Spin, Typography,
} from 'antd';
import { LogoutOutlined, MenuOutlined, UserOutlined } from '@ant-design/icons';
import zhTW from 'antd/locale/zh_TW';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Sidebar, { NAV_GROUPS, SIDEBAR_COLLAPSED, SIDEBAR_WIDTH, useNarrow } from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Chat from './pages/Chat';
import Models from './pages/Models';
import Catalog from './pages/Catalog';
import Engines from './pages/Engines';
import ComfyUI from './pages/ComfyUI';
import Files from './pages/Files';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Gpu from './pages/Gpu';
import Connections from './pages/Connections';
import Logs from './pages/Logs';
import Runtime from './pages/Runtime';
import About from './pages/About';
import Login from './pages/Login';
import { StreamProvider, useStream } from './stream';
import { IdentityProvider } from './identity';
import { ChatProvider } from './chat';
import { PythonRuntimeProvider } from './components/pythonRuntime';
import { fetchAuth, fetchSettings, logout, type AuthState } from './api';
import { setMaxSteps } from './sandboxTool';
import { darkTheme, LINE, MONO } from './theme';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

const ROUTES = [
  { path: '/', element: <Dashboard /> },
  { path: '/chat', element: <Chat /> },
  { path: '/models', element: <Models /> },
  { path: '/catalog', element: <Catalog /> },
  { path: '/engines', element: <Engines /> },
  { path: '/comfyui', element: <ComfyUI /> },
  { path: '/runtime', element: <Runtime /> },
  { path: '/files', element: <Files /> },
  { path: '/users', element: <Users /> },
  { path: '/gpu', element: <Gpu /> },
  { path: '/connections', element: <Connections /> },
  { path: '/logs', element: <Logs /> },
  { path: '/settings', element: <Settings /> },
  { path: '/about', element: <About /> },
];

const TITLES: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])),
);

function Shell({ auth, onSignOut }: { auth: AuthState; onSignOut: () => void }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sider') === 'collapsed');
  const { gpus, models, system } = useStream();
  // A phone or a narrow window: the sidebar becomes a drawer behind a button.
  const narrow = useNarrow();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem('sider', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  // The browser tab is often one of many; naming the page makes it findable.
  useEffect(() => {
    const title = TITLES[location.pathname];
    document.title = title ? `${title} ・ TenkStack` : 'TenkStack';
  }, [location.pathname]);

  return (
    <ConfigProvider locale={zhTW} theme={darkTheme}>
      <AntApp>
        <Layout style={{ minHeight: '100vh' }}>
          {narrow ? (
            <Drawer
              open={drawerOpen}
              onClose={() => setDrawerOpen(false)}
              placement="left"
              width={SIDEBAR_WIDTH}
              closable={false}
              styles={{ body: { padding: 0 } }}
            >
              <Sidebar collapsed={false} onCollapse={setCollapsed} drawer
                       onNavigate={() => setDrawerOpen(false)}
                       gpus={gpus} models={models} system={system} />
            </Drawer>
          ) : (
            <Sidebar collapsed={collapsed} onCollapse={setCollapsed}
                     gpus={gpus} models={models} system={system} />
          )}

          {/* The sider is fixed, so the content needs the space reserved. */}
          <Layout style={{
            marginInlineStart: narrow ? 0 : collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH,
            transition: 'margin-inline-start 200ms',
            minWidth: 0,
          }}>
            <Header style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              paddingInline: narrow ? 12 : 24, position: 'sticky', top: 0, zIndex: 10,
              borderBottom: `1px solid ${LINE.faint}`,
            }}>
              <Space size={8} style={{ minWidth: 0 }}>
                {narrow && (
                  <Button type="text" icon={<MenuOutlined />} aria-label="選單"
                          onClick={() => setDrawerOpen(true)} />
                )}
                <Title level={5} style={{
                  margin: 0, fontFamily: MONO, letterSpacing: 1, fontWeight: 400,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {TITLES[location.pathname] ?? 'TenkStack'}
                </Title>
              </Space>
              <Space size={16}>
                {auth.identity ? (
                  <Dropdown
                    menu={{
                      items: [{ key: 'logout', icon: <LogoutOutlined />, label: '登出' }],
                      onClick: onSignOut,
                    }}
                  >
                    <Button type="text" icon={<UserOutlined />}>{auth.identity.username}</Button>
                  </Dropdown>
                ) : (
                  <Text type="warning">未啟用驗證</Text>
                )}
              </Space>
            </Header>

            <Content style={{ padding: narrow ? 12 : 24, minWidth: 0 }}>
              <Routes>
                {ROUTES.map(({ path, element }) => (
                  <Route key={path} path={path} element={element} />
                ))}
                {/* Unknown paths go home rather than showing a blank frame. */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Content>
          </Layout>
        </Layout>
      </AntApp>
    </ConfigProvider>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const refreshAuth = useCallback(() => {
    fetchAuth()
      // A 401 is the expected answer when signed out, not a failure to report.
      .then(setAuth)
      .catch(() => setAuth({ identity: null, enforcement: true }));
  }, []);

  useEffect(() => { refreshAuth(); }, [refreshAuth]);

  // Applied once, at the top, because the agent loop imports the limit as a
  // module binding rather than taking it as a prop. Failing to reach the API
  // leaves the built-in default, which is what it was before it was settable.
  useEffect(() => {
    fetchSettings()
      .then((all) => {
        const steps = all.find((s) => s.name === 'agent_max_steps');
        if (steps) setMaxSteps(steps.value);
      })
      .catch(() => undefined);
  }, [auth?.identity?.username]);

  if (auth === null) {
    return (
      <ConfigProvider locale={zhTW} theme={darkTheme}>
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
          <Spin size="large" />
        </div>
      </ConfigProvider>
    );
  }

  if (auth.enforcement && !auth.identity) {
    return (
      <ConfigProvider locale={zhTW} theme={darkTheme}>
        <AntApp><Login onSuccess={refreshAuth} /></AntApp>
      </ConfigProvider>
    );
  }

  return (
    <BrowserRouter>
      {/* Inside the router so pages can navigate, and inside the auth gate so
          the stream is never opened by a caller who would only get 401s. */}
      <StreamProvider>
        {/* Above the routes so a streaming reply survives navigating away. */}
        {/* Outside the chat, because the chat reads it. Nothing boots until
            something asks to run code, so a conversation that never uses the
            sandbox never pays for it. */}
        <PythonRuntimeProvider>
        <ChatProvider>
          <IdentityProvider value={auth}>
            <Shell auth={auth} onSignOut={() => logout().then(refreshAuth)} />
          </IdentityProvider>
        </ChatProvider>
        </PythonRuntimeProvider>
      </StreamProvider>
    </BrowserRouter>
  );
}
