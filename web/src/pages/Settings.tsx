import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Col, InputNumber, Row, Space, Tag, Tooltip,
  Typography,
} from 'antd';
import Versions from '../components/Versions';
import {
  fetchConfig, fetchMachine, fetchSettings, saveConfigRaw, saveSettings,
  type MachinePath, type MachineUnit, type Setting,
} from '../api';
import { LINE, MONO } from '../theme';

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
 * The layout is a list rather than a table. Tables with their headers hidden
 * are what this was, and they read as a grid whose columns mean nothing: every
 * row here is a label, a sentence and one control, which is a list.
 */

const GROUPS: { key: string; label: string; note: string }[] = [
  { key: 'chat', label: '對話與預估', note: 'Agent 與模型目錄' },
  { key: 'vram', label: '顯存政策', note: '聊天請求何時把 ComfyUI 清出顯示卡' },
  { key: 'history', label: '保留量', note: '伺服器端緩衝' },
];

const UNIT_COLOUR: Record<string, string> = {
  active: 'green', activating: 'orange', failed: 'red', inactive: 'default',
};

/** A small-caps heading, matching the version block's. */
function Heading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <Space size={8} align="baseline" style={{ marginBottom: 2 }}>
      <Text style={{ fontSize: 10, letterSpacing: 1, opacity: 0.4 }}>{children}</Text>
      {note && <Text style={{ fontSize: 11, opacity: 0.35 }}>{note}</Text>}
    </Space>
  );
}

function Line({ label, note, right }: {
  label: React.ReactNode; note?: string; right: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, minHeight: 40,
      padding: '6px 0', borderBottom: `1px solid ${LINE.faint}`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {note && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 1 }}>
            {note}
          </Text>
        )}
      </div>
      <div style={{ flex: 'none' }}>{right}</div>
    </div>
  );
}

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
      style={{ height: '100%' }}
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
      {GROUPS.map((group, index) => {
        const rows = settings.filter((s) => s.group === group.key);
        if (rows.length === 0) return null;
        return (
          <div key={group.key} style={{ marginTop: index === 0 ? 0 : 14 }}>
            <Heading note={group.note}>{group.label}</Heading>
            {rows.map((row) => (
              <Line
                key={row.name}
                label={row.label}
                note={row.note}
                right={(
                  <Space size={6}>
                    {/* Shown only when it differs, because "this one was
                        changed" is the useful signal and every row carrying a
                        default would be noise. */}
                    {valueOf(row) !== row.default && (
                      <Tooltip title={`預設 ${row.default} ${row.unit}`}>
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
                      style={{ width: 128 }}
                      addonAfter={<span style={{ fontSize: 11 }}>{row.unit}</span>}
                    />
                  </Space>
                )}
              />
            ))}
          </div>
        );
      })}
    </Card>
  );

  const machine = (
    <Card title="這台機器" size="small" style={{ height: '100%' }}
          loading={paths.length === 0}>
      <Heading note="環境變數可移動">路徑</Heading>
      {paths.map((path) => (
        <Line
          key={path.variable}
          label={(
            <Space size={6}>
              <span>{path.label}</span>
              {!path.exists && <Tag color="warning">不存在</Tag>}
            </Space>
          )}
          note={path.path}
          right={(
            <Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>
              {path.variable}
            </Text>
          )}
        />
      ))}

      <div style={{ marginTop: 14 }}>
        <Heading note="容器在「執行環境」頁">systemd 服務</Heading>
        {units.map((unit) => (
          <Line
            key={unit.name}
            label={<span style={{ fontFamily: MONO, fontSize: 12 }}>
              {unit.name.replace(/\.service$/, '')}
            </span>}
            note={unit.note}
            right={(
              <Tooltip title={unit.since || undefined}>
                <Tag color={UNIT_COLOUR[unit.active] ?? 'default'}
                     style={{ marginInlineEnd: 0 }}>
                  {unit.active === 'active' ? '執行中' : unit.active}
                </Tag>
              </Tooltip>
            )}
          />
        ))}
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
          border: `1px solid ${LINE.faint}`, background: 'transparent',
          color: 'inherit', resize: 'vertical',
        }}
      />
    </Card>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={13}>{behaviour}</Col>
        <Col xs={24} xl={11}>{machine}</Col>
      </Row>
      <Versions />
      {configCard}
    </Space>
  );
}
