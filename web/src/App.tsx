import { useCallback, useEffect, useState } from 'react';
import {
  App as AntApp, Button, ConfigProvider, Dropdown, Layout, Space, Spin, Typography,
} from 'antd';
import { LogoutOutlined, UserOutlined } from '@ant-design/icons';
import zhTW from 'antd/locale/zh_TW';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Sidebar, { NAV_GROUPS, SIDEBAR_COLLAPSED, SIDEBAR_WIDTH } from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Chat from './pages/Chat';
import Models from './pages/Models';
import Catalog from './pages/Catalog';
import ComfyUI from './pages/ComfyUI';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Gpu from './pages/Gpu';
import Connections from './pages/Connections';
import Logs from './pages/Logs';
import Login from './pages/Login';
import { StreamProvider, useStream } from './stream';
import { ChatProvider } from './chat';
import { fetchAuth, logout, type AuthState } from './api';
import { darkTheme, LINE, MONO } from './theme';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

const ROUTES = [
  { path: '/', element: <Dashboard /> },
  { path: '/chat', element: <Chat /> },
  { path: '/models', element: <Models /> },
  { path: '/catalog', element: <Catalog /> },
  { path: '/comfyui', element: <ComfyUI /> },
  { path: '/users', element: <Users /> },
  { path: '/gpu', element: <Gpu /> },
  { path: '/connections', element: <Connections /> },
  { path: '/logs', element: <Logs /> },
  { path: '/settings', element: <Settings /> },
];

const TITLES: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])),
);

function Shell({ auth, onSignOut }: { auth: AuthState; onSignOut: () => void }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sider') === 'collapsed');
  const { gpus, models } = useStream();

  useEffect(() => {
    localStorage.setItem('sider', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  // The browser tab is often one of many; naming the page makes it findable.
  useEffect(() => {
    const title = TITLES[location.pathname];
    document.title = title ? `${title} ・ Tenks Console` : 'Tenks Console';
  }, [location.pathname]);

  return (
    <ConfigProvider locale={zhTW} theme={darkTheme}>
      <AntApp>
        <Layout style={{ minHeight: '100vh' }}>
          <Sidebar collapsed={collapsed} onCollapse={setCollapsed} gpus={gpus} models={models} />

          {/* The sider is fixed, so the content needs the space reserved. */}
          <Layout style={{
            marginInlineStart: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH,
            transition: 'margin-inline-start 200ms',
          }}>
            <Header style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingInline: 24, position: 'sticky', top: 0, zIndex: 10,
              borderBottom: `1px solid ${LINE.faint}`,
            }}>
              <Title level={5} style={{
                margin: 0, fontFamily: MONO, letterSpacing: 1, fontWeight: 400,
              }}>
                {TITLES[location.pathname] ?? 'Tenks Console'}
              </Title>
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

            <Content style={{ padding: 24 }}>
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
        <ChatProvider>
          <Shell auth={auth} onSignOut={() => logout().then(refreshAuth)} />
        </ChatProvider>
      </StreamProvider>
    </BrowserRouter>
  );
}
