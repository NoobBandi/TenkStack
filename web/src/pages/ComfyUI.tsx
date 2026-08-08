import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Col, Empty, Image, Row, Space, Statistic, Tag, Typography,
} from 'antd';
import { ExportOutlined, StopOutlined } from '@ant-design/icons';
import {
  comfyImageUrl, fetchComfy, fetchComfyHistory, interruptComfy,
  type ComfyHistoryItem, type ComfyStatus,
} from '../api';

const { Text, Paragraph } = Typography;

/**
 * ComfyUI is republished by Caddy on :8444 behind this console's login; the
 * container itself only listens on loopback. Derived from the current host
 * rather than hardcoded so it resolves correctly whether the console was opened
 * on this machine or from elsewhere on the network.
 *
 * Falls back to the raw container port when the console is being served by the
 * Vite dev server, which sits in front of neither.
 */
const COMFY_ORIGIN =
  window.location.protocol === 'https:'
    ? `https://${window.location.hostname}:8444`
    : `http://${window.location.hostname}:8188`;

export default function ComfyUI() {
  const { message } = AntApp.useApp();
  const [status, setStatus] = useState<ComfyStatus | null>(null);
  const [history, setHistory] = useState<ComfyHistoryItem[]>([]);
  const [embed, setEmbed] = useState(false);

  const refresh = useCallback(() => {
    fetchComfy().then(setStatus).catch(() => setStatus({ reachable: false }));
    fetchComfyHistory().then(setHistory).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    // ComfyUI publishes no event stream to the console, so queue depth is the
    // one thing here that genuinely has to be polled.
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const onInterrupt = async () => {
    try {
      await interruptComfy();
      message.success('已送出中斷');
      refresh();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  if (status && !status.reachable) {
    return (
      <Alert
        type="warning"
        showIcon
        message="ComfyUI 未執行"
        description={
          <span>
            以 <code>~/ai/comfyui/run-comfyui.sh</code> 啟動。容器設定為
            <code> --restart unless-stopped</code>，開機會自動啟動。
          </span>
        }
      />
    );
  }

  const busy = (status?.queue_running ?? 0) > 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card><Statistic title="執行中" value={status?.queue_running ?? 0} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card><Statistic title="佇列中" value={status?.queue_pending ?? 0} /></Card>
        </Col>
        <Col xs={24} md={12}>
          <Card>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space wrap>
                <Tag color="green">ComfyUI {status?.version}</Tag>
                <Tag>Python {status?.python}</Tag>
                {status?.devices?.map((d: { name?: string }) => (
                  <Tag key={d.name} color="blue">{d.name}</Tag>
                ))}
              </Space>
              <Space>
                <Button size="small" danger icon={<StopOutlined />}
                        disabled={!busy} onClick={onInterrupt}>
                  中斷目前工作
                </Button>
                <Button size="small" icon={<ExportOutlined />}
                        href={COMFY_ORIGIN} target="_blank" rel="noreferrer">
                  開啟原生介面
                </Button>
                <Button size="small" onClick={() => setEmbed((v) => !v)}>
                  {embed ? '收起內嵌' : '內嵌顯示'}
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>
      </Row>

      <Alert
        type="info"
        showIcon
        message="ComfyUI 是單一佇列設計"
        description="它沒有多使用者概念——所有人的工作共用同一條佇列，而且直接開原生介面會看到彼此的佇列內容。單張顯示卡本來就只能依序處理，這是硬體限制而非設定問題。"
      />

      <Card title="最近的產出" size="small" extra={<Button size="small" onClick={refresh}>重新整理</Button>}>
        {history.length === 0 ? (
          <Empty description="尚無紀錄" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Image.PreviewGroup>
            <Space wrap size={12}>
              {history.flatMap((item) =>
                item.images.map((img) => (
                  <div key={`${item.prompt_id}-${img.filename}`} style={{ width: 160 }}>
                    <Image
                      src={comfyImageUrl(img)}
                      width={160}
                      height={160}
                      style={{ objectFit: 'cover', borderRadius: 6 }}
                    />
                    <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                      {img.filename}
                    </Text>
                  </div>
                )),
              )}
            </Space>
          </Image.PreviewGroup>
        )}
      </Card>

      {embed && (
        <Card size="small" styles={{ body: { padding: 0 } }}>
          <Paragraph type="secondary" style={{ fontSize: 12, padding: '8px 12px', margin: 0 }}>
            內嵌的是 ComfyUI 自己的介面，功能完整。若進度不更新，請改用「開啟原生介面」——
            ComfyUI 的進度回報走 WebSocket，某些瀏覽器對跨埠內嵌的處理較嚴格。
          </Paragraph>
          <iframe
            title="ComfyUI"
            src={COMFY_ORIGIN}
            style={{ width: '100%', height: '75vh', border: 0 }}
          />
        </Card>
      )}
    </Space>
  );
}
