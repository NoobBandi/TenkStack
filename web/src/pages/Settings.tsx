import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, InputNumber, Space, Table, Tag, Tooltip,
  Typography,
} from 'antd';
import Versions from '../components/Versions';
import {
  fetchConfig, fetchMachine, fetchSettings, saveConfigRaw, saveSettings,
  type MachinePath, type MachineUnit, type Setting,
} from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

/**
 * The console's own settings.
 *
 * This page used to be four cards of which one was a setting. The other three
 * described the machine -- hardware, paths, services -- and two of them did it
 * from constants written into the source, so they were true of exactly one
 * install and quietly wrong everywhere else. Hardware went to the dashboard,
 * which shows it live; the containers went to the runtime page, which reads
 * them from Docker.
 *
 * What is left is what the name promised: things somebody would change, and
 * the few facts about this install that nothing else answers.
 */

const GROUPS: { key: string; label: string; note: string }[] = [
  { key: 'chat', label: '對話與預估', note: '影響 Agent 與模型目錄的預估' },
  { key: 'vram', label: '顯存政策', note: '決定聊天請求何時把 ComfyUI 清出顯示卡' },
  { key: 'history', label: '保留量', note: '伺服器端緩衝的大小' },
];

const UNIT_COLOUR: Record<string, string> = {
  active: 'green', activating: 'orange', failed: 'red', inactive: 'default',
};

export default function Settings() {
  const { message } = AntApp.useApp();
  const [raw, setRaw] = useState('');
  const [original, setOriginal] = useState('');
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [applying, setApplying] = useState(false);
  const [paths, setPaths] = useState<MachinePath[]>([]);
  const [units, setUnits] = useState<MachineUnit[]>([]);

  const refresh = useCallback(() => {
    fetchConfig().then((c) => { setRaw(c.raw); setOriginal(c.raw); }).catch(() => undefined);
    fetchSettings().then((all) => { setSettings(all); setDraft({}); }).catch(() => undefined);
    fetchMachine().then((m) => { setPaths(m.paths); setUnits(m.units); }).catch(() => undefined);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onSaveConfig = async () => {
    setSaving(true);
    try {
      await saveConfigRaw(raw);
      setOriginal(raw);
      message.success('已儲存，llama-swap 已重載（原檔備份為 config.yaml.bak）');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onApply = async () => {
    setApplying(true);
    try {
      setSettings(await saveSettings(draft));
      setDraft({});
      message.success('已套用');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const valueOf = (setting: Setting) => draft[setting.name] ?? setting.value;
  const dirty = Object.keys(draft).length > 0;

  const behaviour = (
    <Card
      title="主控台行為"
      size="small"
      loading={settings.length === 0}
      extra={
        <Space>
          <Button size="small" disabled={!dirty} onClick={() => setDraft({})}>還原</Button>
          <Button size="small" type="primary" loading={applying} disabled={!dirty}
                  onClick={onApply}>
            套用
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        {GROUPS.map((group) => {
          const rows = settings.filter((s) => s.group === group.key);
          if (rows.length === 0) return null;
          return (
            <div key={group.key}>
              <Space size={8} style={{ marginBottom: 6 }}>
                <Text strong style={{ fontSize: 13 }}>{group.label}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{group.note}</Text>
              </Space>
              <Table<Setting>
                dataSource={rows}
                rowKey="name"
                size="small"
                pagination={false}
                showHeader={false}
                columns={[
                  {
                    title: '',
                    render: (_, row) => (
                      <Space direction="vertical" size={0}>
                        <Text style={{ fontSize: 13 }}>{row.label}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{row.note}</Text>
                      </Space>
                    ),
                  },
                  {
                    title: '', width: 190, align: 'right' as const,
                    render: (_, row) => (
                      <Space size={6}>
                        {/* The default is worth showing beside the field: it is
                            the answer to "what was this before I touched it",
                            and clearing a value back to it deletes the row
                            rather than storing a duplicate of the default. */}
                        {valueOf(row) !== row.default && (
                          <Tooltip title={`預設 ${row.default}`}>
                            <Tag style={{ marginInlineEnd: 0 }}>已改</Tag>
                          </Tooltip>
                        )}
                        <InputNumber
                          size="small"
                          min={row.minimum}
                          max={row.maximum}
                          value={valueOf(row)}
                          onChange={(v) => setDraft((prev) => ({
                            ...prev, [row.name]: Number(v ?? row.default),
                          }))}
                          style={{ width: 110 }}
                          addonAfter={<span style={{ fontSize: 11 }}>{row.unit}</span>}
                        />
                      </Space>
                    ),
                  },
                ]}
              />
            </div>
          );
        })}
      </Space>
    </Card>
  );

  const machine = (
    <Card title="這台機器" size="small" loading={paths.length === 0}>
      <Table<MachinePath>
        dataSource={paths}
        rowKey="variable"
        size="small"
        pagination={false}
        showHeader={false}
        columns={[
          {
            title: '', width: 130,
            render: (_, row) => <Text style={{ fontSize: 13 }}>{row.label}</Text>,
          },
          {
            title: '',
            render: (_, row) => (
              <Space size={6}>
                <Text style={{ fontFamily: MONO, fontSize: 12 }}>{row.path}</Text>
                {!row.exists && <Tag color="warning">不存在</Tag>}
              </Space>
            ),
          },
          {
            // The variable, not just the value: every path here is an
            // environment variable with a default, and this is the only place
            // that says which one moves it.
            title: '', width: 230, align: 'right' as const,
            render: (_, row) => (
              <Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>
                {row.variable}
              </Text>
            ),
          },
        ]}
      />

      <div style={{ marginTop: 12 }}>
        <Text strong style={{ fontSize: 13 }}>服務</Text>
        <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
          systemd user unit；容器在「執行環境」頁
        </Text>
        <Table<MachineUnit>
          style={{ marginTop: 6 }}
          dataSource={units}
          rowKey="name"
          size="small"
          pagination={false}
          showHeader={false}
          columns={[
            {
              title: '', width: 130,
              render: (_, row) => (
                <Text style={{ fontFamily: MONO, fontSize: 12 }}>
                  {row.name.replace(/\.service$/, '')}
                </Text>
              ),
            },
            {
              title: '',
              render: (_, row) => (
                <Text type="secondary" style={{ fontSize: 12 }}>{row.note}</Text>
              ),
            },
            {
              title: '', width: 120, align: 'right' as const,
              render: (_, row) => (
                <Tooltip title={row.since || undefined}>
                  <Tag color={UNIT_COLOUR[row.active] ?? 'default'}
                       style={{ marginInlineEnd: 0 }}>
                    {row.active === 'active' ? '執行中' : row.active}
                  </Tag>
                </Tooltip>
              ),
            },
          ]}
        />
      </div>
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
                  disabled={raw === original} onClick={onSaveConfig}>
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
        description="「模型」頁的新增與修改最後都會寫進這個檔案。儲存後會等 llama-swap 表態：它不接受的設定會被還原，而不是留在檔案裡讓之後每次編輯都被默默丟掉。原檔備份為 config.yaml.bak。"
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {behaviour}
      {machine}
      <Versions />
      {configCard}
    </Space>
  );
}
