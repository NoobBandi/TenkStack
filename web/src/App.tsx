import { useCallback, useEffect, useState } from 'react';
import {
  App as AntApp, Button, ConfigProvider, Dropdown, Layout, Menu, Space, Spin, Switch,
  Typography, theme,
} from 'antd';
import {
  AppstoreOutlined, CloudDownloadOutlined, DashboardOutlined, LogoutOutlined, MessageOutlined,
  PictureOutlined, SettingOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import zhTW from 'antd/locale/zh_TW';
import Dashboard from './pages/Dashboard';
import Chat from './pages/Chat';
import Models from './pages/Models';
import Catalog from './pages/Catalog';
import ComfyUI from './pages/ComfyUI';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Login from './pages/Login';
import { fetchAuth, logout, type AuthState } from './api';

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

const NAV = [
  { key: 'dashboard', icon: <DashboardOutlined />, label: '總覽', element: <Dashboard /> },
  { key: 'chat', icon: <MessageOutlined />, label: '對話', element: <Chat /> },
  { key: 'models', icon: <AppstoreOutlined />, label: '模型', element: <Models /> },
  { key: 'catalog', icon: <CloudDownloadOutlined />, label: '模型目錄', element: <Catalog /> },
  { key: 'comfyui', icon: <PictureOutlined />, label: '圖像生成', element: <ComfyUI /> },
  { key: 'users', icon: <TeamOutlined />, label: '使用者', element: <Users /> },
  { key: 'settings', icon: <SettingOutlined />, label: '設定', element: <Settings /> },
];

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [dark, setDark] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [auth, setAuth] = useState<AuthState | null>(null);

  const refreshAuth = useCallback(() => {
    fetchAuth()
      .then(setAuth)
      // A 401 is the expected answer when signed out, not a failure to report.
      .catch(() => setAuth({ identity: null, enforcement: true }));
  }, []);

  useEffect(() => { refreshAuth(); }, [refreshAuth]);

  const current = NAV.find((n) => n.key === page) ?? NAV[0];
  const themeConfig = { algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm };

  if (auth === null) {
    return (
      <ConfigProvider locale={zhTW} theme={themeConfig}>
        <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
          <Spin size="large" />
        </div>
      </ConfigProvider>
    );
  }

  if (auth.enforcement && !auth.identity) {
    return (
      <ConfigProvider locale={zhTW} theme={themeConfig}>
        <AntApp><Login onSuccess={refreshAuth} /></AntApp>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider locale={zhTW} theme={themeConfig}>
      <AntApp>
        <Layout style={{ minHeight: '100vh' }}>
          <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed}
                 theme={dark ? 'dark' : 'light'} width={200}>
            <div style={{
              height: 48, margin: 12, display: 'flex', alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'flex-start', overflow: 'hidden',
            }}>
              <Title level={5} style={{ margin: 0, whiteSpace: 'nowrap' }}>
                {collapsed ? 'AI' : 'AI Console'}
              </Title>
            </div>
            <Menu
              theme={dark ? 'dark' : 'light'}
              mode="inline"
              selectedKeys={[page]}
              items={NAV.map(({ key, icon, label }) => ({ key, icon, label }))}
              onClick={({ key }) => setPage(key)}
            />
          </Sider>

          <Layout>
            <Header style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              paddingInline: 24,
            }}>
              <Title level={4} style={{ margin: 0 }}>{current.label}</Title>
              <Space size={16}>
                <Switch checked={dark} onChange={setDark} checkedChildren="暗" unCheckedChildren="亮" />
                {auth.identity ? (
                  <Dropdown
                    menu={{
                      items: [{ key: 'logout', icon: <LogoutOutlined />, label: '登出' }],
                      onClick: () => logout().then(refreshAuth),
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
              {/* Keyed so switching pages resets page-local state instead of
                  carrying one page's form values into the next. */}
              <div key={current.key}>{current.element}</div>
            </Content>
          </Layout>
        </Layout>
      </AntApp>
    </ConfigProvider>
  );
}
