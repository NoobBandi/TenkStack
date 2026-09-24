import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography,
} from 'antd';
import { KeyOutlined, PlusOutlined } from '@ant-design/icons';
import {
  createApiKey, createUser, deleteApiKey, deleteUser, fetchApiKeys, fetchUsers, setPassword,
  type ApiKey, type User,
} from '../api';
import { useAuthState, useIsOwner } from '../identity';

const { Text, Paragraph } = Typography;

const formatTime = (seconds: number | null) =>
  seconds ? new Date(seconds * 1000).toLocaleString() : '—';

export default function Users() {
  const { message } = AntApp.useApp();
  // The administrator manages everyone; a member sees their own account --
  // their password and their keys -- and nothing of anyone else's.
  const owner = useIsOwner();
  const me = useAuthState()?.identity ?? null;
  const [users, setUsers] = useState<User[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [userOpen, setUserOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState<User | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [userForm] = Form.useForm();
  const [keyForm] = Form.useForm();
  const [pwForm] = Form.useForm();

  const refresh = useCallback(() => {
    if (owner) fetchUsers().then(setUsers).catch(() => undefined);
    fetchApiKeys().then(setKeys).catch(() => undefined);
  }, [owner]);

  useEffect(() => { refresh(); }, [refresh]);

  const guard = async (action: () => Promise<unknown>, ok: string) => {
    try {
      await action();
      message.success(ok);
      refresh();
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={owner ? '誰能做什麼' : '你的帳號'}
        description={
          <span>
            成員可以對話、載入與卸載模型、中斷 ComfyUI 正在跑的工作，也能改自己的密碼、管理自己的 API key。
            新增或刪除帳號與模型、下載模型、刪除檔案、更新 ComfyUI、開放對外連線與改設定，都只有管理員能做。
            API key 只能用在 <code>/v1</code> 的模型 API（給 Claude Code、Pi 這類工具），不能拿來操作主控台。
          </span>
        }
      />

      {!owner && me && (
        <Card title="我的帳號" size="small">
          <Space size={16} wrap>
            <div>
              <div>{me.username}</div>
              <Text type="secondary" style={{ fontSize: 12 }}>{me.role === 'admin' ? '管理員' : '成員'}</Text>
            </div>
            <Button size="small" onClick={() => {
              pwForm.resetFields();
              setPwOpen({ id: me.user_id, username: me.username } as User);
            }}>
              改密碼
            </Button>
          </Space>
        </Card>
      )}

      {owner && <Card
        title="使用者"
        size="small"
        extra={
          <Button size="small" type="primary" icon={<PlusOutlined />}
                  onClick={() => { userForm.resetFields(); setUserOpen(true); }}>
            新增使用者
          </Button>
        }
      >
        <Table<User>
          dataSource={users}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: '尚未建立任何帳號' }}
          columns={[
            {
              title: '名稱', dataIndex: 'display_name',
              render: (name: string, row) => (
                <div>
                  <div>{name}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{row.username}</Text>
                </div>
              ),
            },
            {
              title: '角色', dataIndex: 'role', width: 100,
              render: (role: string) => (
                <Tag color={role === 'admin' ? 'red' : 'blue'}>{role}</Tag>
              ),
            },
            { title: 'API key', dataIndex: 'key_count', width: 90 },
            {
              title: '建立時間', dataIndex: 'created_at', width: 180,
              render: (t: number) => formatTime(t),
            },
            {
              title: '操作', width: 190,
              render: (_, row) => (
                <Space size="small">
                  <Button size="small" onClick={() => { pwForm.resetFields(); setPwOpen(row); }}>
                    改密碼
                  </Button>
                  <Popconfirm title={`刪除 ${row.username}？`} description="該使用者的 API key 會一併刪除。"
                              onConfirm={() => guard(() => deleteUser(row.id), '已刪除')}
                              okText="刪除" cancelText="取消">
                    <Button size="small" danger>刪除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>}

      <Card
        title={owner ? 'API Key' : '我的 API Key'}
        size="small"
        extra={
          <Button size="small" icon={<KeyOutlined />} disabled={owner ? users.length === 0 : !me}
                  onClick={() => { keyForm.resetFields(); setKeyOpen(true); }}>
            建立 Key
          </Button>
        }
      >
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          給非瀏覽器的用戶端使用（其他 App、腳本、外部工具）。Key 只會在建立當下顯示一次，
          資料庫中只留 SHA-256 雜湊。
        </Paragraph>
        <Table<ApiKey>
          dataSource={keys}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: '尚未建立 API key' }}
          columns={[
            { title: '名稱', dataIndex: 'name' },
            ...(owner ? [{ title: '所屬', dataIndex: 'username', width: 120 }] : []),
            {
              title: '前綴', dataIndex: 'prefix', width: 180,
              render: (p: string) => <code>{p}…</code>,
            },
            {
              title: '最後使用', dataIndex: 'last_used_at', width: 180,
              render: (t: number | null) => formatTime(t),
            },
            {
              title: '', width: 80,
              render: (_, row) => (
                <Popconfirm title="撤銷這把 key？" onConfirm={() => guard(() => deleteApiKey(row.id), '已撤銷')}
                            okText="撤銷" cancelText="取消">
                  <Button size="small" danger>撤銷</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="新增使用者"
        open={userOpen}
        onCancel={() => setUserOpen(false)}
        onOk={async () => {
          const values = await userForm.validateFields();
          if (await guard(() => createUser(values), '已建立')) setUserOpen(false);
        }}
        okText="建立"
        cancelText="取消"
      >
        <Form form={userForm} layout="vertical" initialValues={{ role: 'member' }}>
          <Form.Item name="username" label="帳號" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="display_name" label="顯示名稱"><Input /></Form.Item>
          <Form.Item name="password" label="密碼" rules={[{ required: true, min: 4 }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Select options={[
              { value: 'member', label: 'member — 一般使用' },
              { value: 'admin', label: 'admin — 可管理模型與使用者' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="建立 API Key"
        open={keyOpen}
        onCancel={() => setKeyOpen(false)}
        onOk={async () => {
          const values = await keyForm.validateFields();
          try {
            const created = await createApiKey(owner ? values.user_id : me!.user_id, values.name);
            setKeyOpen(false);
            setRevealed(created.secret);
            refresh();
          } catch (error) {
            message.error((error as Error).message);
          }
        }}
        okText="建立"
        cancelText="取消"
      >
        <Form form={keyForm} layout="vertical">
          {owner && (
            <Form.Item name="user_id" label="所屬使用者" rules={[{ required: true }]}>
              <Select options={users.map((u) => ({ value: u.id, label: `${u.display_name} (${u.username})` }))} />
            </Form.Item>
          )}
          <Form.Item name="name" label="用途名稱" rules={[{ required: true }]}>
            <Input placeholder="例如：手機 App" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="請立即複製這把 Key"
        open={revealed !== null}
        onCancel={() => setRevealed(null)}
        footer={<Button type="primary" onClick={() => setRevealed(null)}>我已保存</Button>}
      >
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
               message="關閉後就無法再看到完整內容——資料庫只存雜湊。" />
        <Input.TextArea value={revealed ?? ''} rows={3} readOnly />
      </Modal>

      <Modal
        title={`修改 ${pwOpen?.username ?? ''} 的密碼`}
        open={pwOpen !== null}
        onCancel={() => setPwOpen(null)}
        onOk={async () => {
          const values = await pwForm.validateFields();
          if (pwOpen && await guard(() => setPassword(pwOpen.id, values.password), '已更新')) {
            setPwOpen(null);
          }
        }}
        okText="更新"
        cancelText="取消"
      >
        <Form form={pwForm} layout="vertical">
          <Form.Item name="password" label="新密碼" rules={[{ required: true, min: 4 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
