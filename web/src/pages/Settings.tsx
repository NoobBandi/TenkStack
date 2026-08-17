import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Descriptions, Space, Tag, Typography,
} from 'antd';
import {
  fetchConfig, fetchGpu, fetchSystem, saveConfigRaw,
  type GpuSample, type SystemSample,
} from '../api';

const { Text, Paragraph } = Typography;

const SERVICES = [
  { name: 'llama-swap', port: 8080, note: 'LLM 生命週期與 OpenAI 相容端點' },
  // One per card, since the device is fixed when the process starts. The
  // ports are the ones the console probes; instances actually running are
  // listed on the ComfyUI page, which asks them rather than assuming.
  { name: 'ComfyUI', port: 8188, note: '圖像生成，B70（容器 comfyui-xpu）' },
  { name: 'ComfyUI', port: 8189, note: '圖像生成，3060（容器 comfyui-nv0）' },
  { name: '主控台 API', port: 8070, note: '本服務' },
];

export default function Settings() {
  const { message } = AntApp.useApp();
  const [raw, setRaw] = useState('');
  const [original, setOriginal] = useState('');
  const [gpus, setGpus] = useState<GpuSample[]>([]);
  const [sys, setSys] = useState<SystemSample | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    fetchConfig().then((c) => { setRaw(c.raw); setOriginal(c.raw); }).catch(() => undefined);
    fetchGpu().then((list) => setGpus(Array.isArray(list) ? list : []))
      .catch(() => undefined);
    fetchSystem().then(setSys).catch(() => undefined);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onSave = async () => {
    setSaving(true);
    try {
      await saveConfigRaw(raw);
      setOriginal(raw);
      message.success('已儲存，llama-swap 會自動重載（原檔備份為 config.yaml.bak）');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const hostCard = (
    <Card title="硬體" size="small">
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
        <Descriptions.Item label="CPU">
          {sys?.cpu?.model ?? '偵測中…'}
          {sys?.cpu?.cores ? `（${sys.cpu.cores} 執行緒）` : ''}
        </Descriptions.Item>
        <Descriptions.Item label="記憶體">
          {sys ? `${(sys.memory.total_bytes / 1024 ** 3).toFixed(0)} GiB` : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="GPU">
          {gpus.length ? gpus.map((g) => `xpu:${g.index} ${g.name}`).join('、') : '偵測中…'}
        </Descriptions.Item>
        <Descriptions.Item label="顯存">
          {gpus.length
            // Summed, with the per-card split shown beside it: a model has to
            // fit in one card, so the total alone would be misleading.
            ? `${(gpus.reduce((sum, g) => sum + (g.memory_total_mib ?? 0), 0) / 1024)
              .toFixed(0)} GiB`
              + (gpus.length > 1
                ? `（${gpus.map((g) => `${((g.memory_total_mib ?? 0) / 1024).toFixed(0)}`)
                  .join(' + ')}）`
                : '')
            : '—'}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );

  const pathsCard = (
    <Card title="路徑" size="small">
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="模型目錄"><code>~/ai/models</code></Descriptions.Item>
        <Descriptions.Item label="llama-swap 設定"><code>~/ai/llama-swap/config.yaml</code></Descriptions.Item>
        <Descriptions.Item label="Caddy 設定"><code>~/ai/caddy/Caddyfile</code></Descriptions.Item>
        <Descriptions.Item label="主控台資料庫"><code>~/ai/ai-console/console.sqlite</code></Descriptions.Item>
      </Descriptions>
    </Card>
  );

  const servicesCard = (
    <Card title="服務" size="small">
      <Space direction="vertical" style={{ width: '100%' }}>
        {SERVICES.map((s) => (
          <div key={s.port}>
            <Space>
              <Tag color="blue">:{s.port}</Tag>
              <strong>{s.name}</strong>
              <Text type="secondary" style={{ fontSize: 12 }}>{s.note}</Text>
            </Space>
          </div>
        ))}
      </Space>
      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        三者都由 systemd user unit 或 Docker restart policy 管理，開機自動啟動。
      </Paragraph>
    </Card>
  );

  const configCard = (
    <Card
      title="llama-swap 設定檔"
      size="small"
      extra={
        <Space>
          <Button size="small" onClick={refresh} disabled={raw === original}>還原</Button>
          <Button size="small" type="primary" loading={saving}
                  disabled={raw === original} onClick={onSave}>
            儲存
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="這是唯一真相來源"
        description="「模型」頁的新增與修改最後都會寫進這個檔案。儲存前會先驗證 YAML 能否解析，不合法會拒絕寫入；寫入前也會備份成 config.yaml.bak。"
      />
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%', height: '52vh', fontFamily: 'ui-monospace, monospace',
          fontSize: 12, lineHeight: 1.5, padding: 12, borderRadius: 6,
          border: '1px solid rgba(128,128,128,0.35)', background: 'transparent',
          color: 'inherit', resize: 'vertical',
        }}
      />
    </Card>
  );

  // One page, stacked. A sub-navigation was tried here and removed: three
  // sections, two of them read-only, is not enough to navigate between -- it
  // added a click and a layout without answering any question the page did not
  // already answer by being scrolled.
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {hostCard}
      {pathsCard}
      {servicesCard}
      {configCard}
    </Space>
  );
}
