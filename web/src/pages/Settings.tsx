import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Col, Input, InputNumber, Popconfirm, Row, Select, Space,
  Tag, Tooltip, Typography,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import Versions from '../components/Versions';
import { bytes } from '../components/files/kit';
import {
  addModelLocation, fetchConfig, fetchMachine, fetchModelLocations, fetchSettings,
  labelModelLocation, locationName, removeModelLocation, saveConfigRaw, saveSettings,
  setModelLocationDefaults,
  type MachinePath, type MachineUnit, type ModelFormat, type ModelLocations, type Setting,
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

const FORMATS: { key: ModelFormat; label: string; note: string }[] = [
  { key: 'gguf', label: 'GGUF 下載到', note: 'llama.cpp 用的模型，從「模型目錄」下載' },
  // Nothing downloads safetensors yet -- the catalog lists GGUF only -- so
  // the note says when this starts to matter rather than looking inert.
  { key: 'safetensors', label: 'safetensors 下載到', note: 'vLLM 用的模型資料夾；模型目錄支援 safetensors 下載後生效' },
];

/**
 * Where models live. A second disk for the large ones, or GGUF and
 * safetensors kept apart: each is a location, and each format has the one new
 * downloads of it land in. The primary is CONSOLE_MODELS_DIR and stays; the
 * others can go once no model loads from them, and the files stay behind.
 */
function ModelLocationsCard() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<ModelLocations | null>(null);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    fetchModelLocations().then(setData).catch(() => undefined);
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      const out = await work();
      if (out && typeof out === 'object' && 'locations' in out) setData(out as ModelLocations);
      else reload();
      if (done) message.success(done);
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onAdd = async () => {
    if (await run(() => addModelLocation(path, label), '已加入')) {
      setAdding(false); setPath(''); setLabel('');
    }
  };

  const locations = data?.locations ?? [];
  const full = data ? locations.length >= data.max : true;
  const options = locations.map((l) => ({ value: l.key, label: locationName(l) }));

  return (
    <Card
      title="模型存放位置"
      size="small"
      loading={!data}
      extra={(
        <Tooltip title={full && data ? `最多 ${data.max} 個位置` : undefined}>
          <Button size="small" icon={<PlusOutlined />} disabled={full || adding}
                  onClick={() => setAdding(true)}>
            新增位置
          </Button>
        </Tooltip>
      )}
    >
      <Heading note="每種格式各有一個預設位置">下載位置</Heading>
      {FORMATS.map((f) => {
        const current = locations.find((l) => l.default_for.includes(f.key));
        return (
          <Line
            key={f.key}
            label={f.label}
            note={f.note}
            right={(
              <Select
                size="small"
                style={{ width: 220 }}
                value={current?.key}
                options={options}
                disabled={busy || locations.length < 2}
                onChange={(key) => run(() => setModelLocationDefaults({ [f.key]: key }), '已變更下載位置')}
              />
            )}
          />
        );
      })}

      <div style={{ marginTop: 14 }}>
        <Heading note="llama.cpp 與 vLLM 都從這些位置讀模型">位置</Heading>
        {locations.map((loc) => {
          const blocked = loc.primary || loc.in_use.length > 0;
          const why = loc.primary
            ? '主要位置不能移除'
            : loc.in_use.length > 0
              ? `還有模型從這裡載入：${loc.in_use.join('、')}`
              : undefined;
          return (
            <Line
              key={loc.key}
              label={(
                <Space size={6} wrap>
                  <Text
                    editable={{
                      text: loc.label,
                      tooltip: '改名稱',
                      onChange: (next) => {
                        if (next.trim() !== loc.label) {
                          run(() => labelModelLocation(loc.key, next));
                        }
                      },
                    }}
                  >
                    {locationName(loc)}
                  </Text>
                  {loc.primary && <Tag style={{ marginInlineEnd: 0 }}>主要</Tag>}
                  {loc.default_for.map((f) => (
                    <Tag key={f} color="blue" style={{ marginInlineEnd: 0 }}>
                      {f === 'gguf' ? 'GGUF 預設' : 'safetensors 預設'}
                    </Tag>
                  ))}
                  {!loc.exists && <Tag color="error" style={{ marginInlineEnd: 0 }}>找不到資料夾</Tag>}
                  {loc.exists && !loc.writable && (
                    <Tag color="warning" style={{ marginInlineEnd: 0 }}>無法寫入</Tag>
                  )}
                </Space>
              )}
              note={[
                loc.path,
                `${loc.models} 個模型・${bytes(loc.used_bytes)}`,
                loc.exists ? `磁碟剩 ${bytes(loc.free_bytes)} / ${bytes(loc.total_bytes)}` : '',
              ].filter(Boolean).join('　')}
              right={(
                <Tooltip title={why}>
                  <Popconfirm
                    title="移除這個位置？"
                    description="只是不再使用，資料夾裡的檔案會留著。"
                    okText="移除"
                    cancelText="取消"
                    disabled={blocked}
                    onConfirm={() => run(() => removeModelLocation(loc.key), '已移除')}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />}
                            disabled={blocked || busy} />
                  </Popconfirm>
                </Tooltip>
              )}
            />
          );
        })}
        {adding && (
          <div style={{ display: 'flex', gap: 8, padding: '10px 0', flexWrap: 'wrap' }}>
            <Input
              size="small"
              autoFocus
              placeholder="完整路徑，例如 /mnt/data/models"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onPressEnter={onAdd}
              style={{ flex: '2 1 260px', fontFamily: MONO }}
            />
            <Input
              size="small"
              placeholder="名稱（可不填）"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onPressEnter={onAdd}
              style={{ flex: '1 1 140px' }}
            />
            <Space size={6}>
              <Button size="small" onClick={() => { setAdding(false); setPath(''); setLabel(''); }}>
                取消
              </Button>
              <Button size="small" type="primary" loading={busy} disabled={!path.trim()}
                      onClick={onAdd}>
                加入
              </Button>
            </Space>
          </div>
        )}
        {adding && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', paddingBottom: 4 }}>
            資料夾不存在會自動建立。路徑不能有空白或冒號，也不能放在系統目錄、ComfyUI 資料夾，或跟其他位置互相包含。
          </Text>
        )}
      </div>
    </Card>
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
      <ModelLocationsCard />
      <Versions />
      {configCard}
    </Space>
  );
}
