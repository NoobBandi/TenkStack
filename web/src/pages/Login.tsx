import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { login } from '../api';

const { Title, Text, Paragraph } = Typography;

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setBusy(true);
    setError(null);
    try {
      await login(values.username, values.password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 24,
    }}>
      <Card style={{ width: 380 }}>
        <Title level={4} style={{ marginTop: 0 }}>TenkStack</Title>
        <Text type="secondary" style={{ fontSize: 12 }}>請登入以繼續</Text>
        {error && (
          <Alert type="error" showIcon message={error} style={{ margin: '12px 0' }} />
        )}
        <Form layout="vertical" onFinish={onFinish} style={{ marginTop: 16 }}>
          <Form.Item name="username" rules={[{ required: true, message: '請輸入帳號' }]}>
            <Input prefix={<UserOutlined />} placeholder="帳號" autoFocus size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '請輸入密碼' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密碼" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={busy}>
            登入
          </Button>
        </Form>
      </Card>
    </div>
  );
}

/**
 * Before the first account exists, only a browser that opened the setup link
 * the installer printed gets in. Anyone else lands here, told where the link
 * is rather than shown a sign-in with no account behind it.
 */
export function SetupLinkNeeded() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 24,
    }}>
      <Card style={{ width: 460 }}>
        <Title level={4} style={{ marginTop: 0 }}>TenkStack</Title>
        <Text>還沒有任何帳號。</Text>
        <Paragraph type="secondary" style={{ fontSize: 13, marginTop: 8 }}>
          第一個帳號只能從安裝程式最後印出的網址建立，那個網址的結尾是 <Text code>?setup=…</Text>。
          找不到的話，在主機上執行下面這行，把印出的 token 接在網址後面再開一次：
        </Paragraph>
        <Paragraph copyable={{ text: SETUP_HINT }} style={{ marginBottom: 0 }}>
          <Text code style={{ fontSize: 12 }}>{SETUP_HINT}</Text>
        </Paragraph>
      </Card>
    </div>
  );
}

const SETUP_HINT = 'journalctl --user -u tenkstack-console | grep -o "setup=[0-9a-f]*" | tail -1';
