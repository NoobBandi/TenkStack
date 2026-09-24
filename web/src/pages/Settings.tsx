import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Collapse, InputNumber, Popconfirm, Select, Space, Switch,
  Tag, Tooltip, Typography,
} from 'antd';
import {
  CheckOutlined, DeleteOutlined, EditOutlined, LoadingOutlined, PlusOutlined,
} from '@ant-design/icons';
import LocationForm from '../components/LocationForm';
import { bytes } from '../components/files/kit';
import {
  addModelLocation, fetchConfig, fetchMachine, fetchModelLocations, fetchSettings,
  locationName, removeModelLocation, saveConfigRaw, saveSettings, setModelLocationDefaults,
  updateModelLocation,
  type MachinePath, type MachineUnit, type ModelFormat, type ModelLocations, type Setting,
} from '../api';
import { useIsOwner } from '../identity';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * The console's own settings, for the administrator.
 *
 * One column, in the order somebody setting the machine up meets them: where
 * models are kept first, since that is decided before anything is downloaded,
 * then how chat behaves, how the cards are shared with ComfyUI, and how much
 * history is kept. What is for the rare occasion -- the raw llama-swap file,
 * where the install lives -- is folded away under 進階. The versions of what is
 * installed are on the about page, beside the update they explain.
 *
 * Every control saves itself: a switch or a choice when it changes, a number
 * when the field is left. An apply button across a page of unrelated settings
 * made it easy to change three and keep none.
 */

/** Which settings each section holds, in the order they are shown. */
const SECTIONS: { title: string; note: string; names: string[] }[] = [
  { title: '對話', note: '對話頁與 Agent 的行為', names: ['agent_max_steps', 'vision_cache', 'estimate_depth'] },
  {
    title: '顯示卡',
    note: 'LLM 與 ComfyUI 共用顯示卡時，什麼時候要先停掉 ComfyUI 讓模型載入',
    names: ['vram_margin_gib', 'comfyui_idle_gib'],
  },
  { title: '紀錄保留', note: '伺服器記住多少，給日誌頁與顯示卡頁往回看', names: ['log_lines', 'gpu_history_hours'] },
];

const UNIT_COLOUR: Record<string, string> = {
  active: 'green', activating: 'orange', failed: 'red', inactive: 'default',
};

/** A small-caps heading inside a card. */
function Heading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <Space size={8} align="baseline" style={{ marginBottom: 2 }}>
      <Text style={{ fontSize: 10, letterSpacing: 1, opacity: 0.4 }}>{children}</Text>
      {note && <Text style={{ fontSize: 11, opacity: 0.35 }}>{note}</Text>}
    </Space>
  );
}

function Line({ label, note, right }: {
  label: React.ReactNode; note?: React.ReactNode; right: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, minHeight: 40,
      padding: '8px 0', borderBottom: `1px solid ${LINE.faint}`,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {note && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2, lineHeight: 1.6 }}>
            {note}
          </Text>
        )}
      </div>
      <div style={{ flex: 'none' }}>{right}</div>
    </div>
  );
}

/** A section: a card whose title says what the settings in it are about. */
function Section({ title, note, children, extra }: {
  title: string; note?: string; children: React.ReactNode; extra?: React.ReactNode;
}) {
  return (
    <Card
      size="small"
      title={(
        <Space size={10} align="baseline">
          <span>{title}</span>
          {note && <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{note}</Text>}
        </Space>
      )}
      extra={extra}
    >
      {children}
    </Card>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * One setting that saves itself. A 0/1 setting with no unit is a switch; a
 * number is kept as typed until the field is left or Enter is pressed, so
 * typing 4096 does not save 4, 40 and 409 on the way.
 */
function SettingRow({ setting, onSaved }: { setting: Setting; onSaved: (all: Setting[]) => void }) {
  const { message } = AntApp.useApp();
  const [draft, setDraft] = useState<number | null>(setting.value);
  const [state, setState] = useState<SaveState>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { setDraft(setting.value); }, [setting.value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const toggle = setting.minimum === 0 && setting.maximum === 1 && !setting.unit;

  const save = async (value: number) => {
    if (value === setting.value) return;
    setState('saving');
    try {
      onSaved(await saveSettings({ [setting.name]: value }));
      setState('saved');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState('idle'), 2000);
    } catch (error) {
      setState('error');
      setDraft(setting.value);
      message.error((error as Error).message);
    }
  };

  const commit = () => {
    if (draft === null || Number.isNaN(draft)) { setDraft(setting.value); return; }
    const clamped = Math.min(setting.maximum, Math.max(setting.minimum, Math.round(draft)));
    setDraft(clamped);
    void save(clamped);
  };

  const changed = setting.value !== setting.default;
  return (
    <Line
      label={setting.label}
      note={setting.note}
      right={(
        <Space size={10}>
          <span style={{ width: 64, textAlign: 'right', fontSize: 12 }}>
            {state === 'saving' && <LoadingOutlined style={{ opacity: 0.6 }} />}
            {state === 'saved' && (
              <Text style={{ fontSize: 12, color: ACCENT.ok }}><CheckOutlined /> 已儲存</Text>
            )}
            {state !== 'saving' && state !== 'saved' && changed && (
              <Tooltip title={`預設是 ${toggle ? (setting.default ? '開' : '關') : `${setting.default} ${setting.unit}`}`}>
                <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }}
                        onClick={() => { setDraft(setting.default); void save(setting.default); }}>
                  恢復預設
                </Button>
              </Tooltip>
            )}
          </span>
          {toggle ? (
            <Switch
              checked={setting.value === 1}
              loading={state === 'saving'}
              onChange={(on) => void save(on ? 1 : 0)}
            />
          ) : (
            <InputNumber
              size="small"
              min={setting.minimum}
              max={setting.maximum}
              value={draft}
              onChange={(v) => setDraft(v === null ? null : Number(v))}
              onBlur={commit}
              onPressEnter={commit}
              style={{ width: 160 }}
              // One width for every unit, so the fields line up down the page.
              addonAfter={<span style={{ fontSize: 11, display: 'inline-block', width: 34, textAlign: 'center' }}>{setting.unit}</span>}
            />
          )}
        </Space>
      )}
    />
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
  const [editing, setEditing] = useState<string | null>(null);
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

  const onAdd = async (path: string, label: string) => {
    if (await run(() => addModelLocation(path, label), '已加入')) setAdding(false);
  };
  const onEdit = async (key: string, path: string, label: string, primary: boolean) => {
    if (await run(() => updateModelLocation(key, label, primary ? undefined : path), '已儲存')) {
      setEditing(null);
    }
  };

  const locations = data?.locations ?? [];
  const full = data ? locations.length >= data.max : true;
  const options = locations.map((l) => ({ value: l.key, label: locationName(l) }));

  return (
    <Card
      title={(
        <Space size={10} align="baseline">
          <span>模型存放</span>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>模型下載到哪裡、從哪裡讀</Text>
        </Space>
      )}
      size="small"
      loading={!data}
      extra={(
        <Tooltip title={full && data ? `最多 ${data.max} 個位置` : undefined}>
          <Button size="small" icon={<PlusOutlined />} disabled={full || adding || editing !== null}
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
          if (editing === loc.key) {
            return (
              <LocationForm
                key={loc.key}
                initialPath={loc.path}
                initialLabel={loc.label}
                lockPath={loc.primary}
                busy={busy}
                submit="儲存"
                onSubmit={(path, label) => onEdit(loc.key, path, label, loc.primary)}
                onCancel={() => setEditing(null)}
              />
            );
          }
          return (
            <Line
              key={loc.key}
              label={(
                <Space size={6} wrap>
                  <span>{locationName(loc)}</span>
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
                // Without a label the name already is the path.
                loc.label || loc.primary ? loc.path : '',
                `${loc.models} 個模型・${bytes(loc.used_bytes)}`,
                loc.exists ? `磁碟剩 ${bytes(loc.free_bytes)} / ${bytes(loc.total_bytes)}` : '',
              ].filter(Boolean).join('　')}
              right={(
                <Space size={2}>
                  <Tooltip title={loc.primary ? '改名稱' : '改路徑或名稱'}>
                    <Button size="small" type="text" icon={<EditOutlined />}
                            disabled={busy || adding || editing !== null}
                            onClick={() => setEditing(loc.key)} />
                  </Tooltip>
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
                </Space>
              )}
            />
          );
        })}
        {adding && (
          <LocationForm
            busy={busy}
            submit="加入"
            onSubmit={onAdd}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    </Card>
  );
}

/**
 * What is here for the rare occasion, folded until asked for: the whole
 * llama-swap file, and where this install lives. Each is read only once its
 * panel is opened.
 */
function Advanced() {
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState<string[]>([]);
  const [raw, setRaw] = useState('');
  const [original, setOriginal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [paths, setPaths] = useState<MachinePath[] | null>(null);
  const [units, setUnits] = useState<MachineUnit[]>([]);

  const loadConfig = useCallback(() => {
    fetchConfig().then((c) => { setRaw(c.raw); setOriginal(c.raw); })
      .catch((e) => message.error((e as Error).message));
  }, [message]);

  useEffect(() => {
    if (open.includes('config') && original === null) loadConfig();
    if (open.includes('machine') && paths === null) {
      fetchMachine().then((m) => { setPaths(m.paths); setUnits(m.units); }).catch(() => setPaths([]));
    }
  }, [open, original, paths, loadConfig]);

  const onSave = async () => {
    setSaving(true);
    try {
      await saveConfigRaw(raw);
      setOriginal(raw);
      message.success('已儲存，llama-swap 已重新載入（原檔備份為 config.yaml.bak）');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dirty = original !== null && raw !== original;

  return (
    <Section title="進階" note="平常用不到；改錯可能讓模型全部載入不了">
      <Collapse
        ghost
        activeKey={open}
        onChange={(keys) => setOpen(keys as string[])}
        items={[
          {
            key: 'config',
            label: 'llama-swap 設定檔',
            extra: open.includes('config') && (
              <Space size={6} onClick={(e) => e.stopPropagation()}>
                <Button size="small" disabled={!dirty} onClick={() => setRaw(original ?? '')}>還原</Button>
                <Button size="small" type="primary" loading={saving} disabled={!dirty} onClick={onSave}>
                  儲存
                </Button>
              </Space>
            ),
            children: (
              <>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10, lineHeight: 1.7 }}>
                  「模型」頁與這一頁的修改最後都會寫進這個檔案。儲存後會等 llama-swap 確認：
                  它不接受的內容會自動還原，不會留在檔案裡。原檔備份為 config.yaml.bak。
                </Text>
                <textarea
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  spellCheck={false}
                  style={{
                    width: '100%', height: '52vh', fontFamily: MONO, fontSize: 12, lineHeight: 1.5,
                    padding: 12, borderRadius: 6, border: `1px solid ${LINE.faint}`,
                    background: 'transparent', color: 'inherit', resize: 'vertical',
                  }}
                />
              </>
            ),
          },
          {
            key: 'machine',
            label: '路徑與服務',
            children: (
              <>
                <Heading note="用環境變數設定，這裡只顯示">路徑</Heading>
                {(paths ?? []).map((path) => (
                  <Line
                    key={path.variable}
                    label={(
                      <Space size={6}>
                        <span>{path.label}</span>
                        {!path.exists && <Tag color="warning">不存在</Tag>}
                      </Space>
                    )}
                    note={path.path}
                    right={<Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>{path.variable}</Text>}
                  />
                ))}
                <div style={{ marginTop: 14 }}>
                  <Heading note="容器在「執行環境」頁">systemd 服務</Heading>
                  {units.map((unit) => (
                    <Line
                      key={unit.name}
                      label={<span style={{ fontFamily: MONO, fontSize: 12 }}>{unit.name.replace(/\.service$/, '')}</span>}
                      note={unit.note}
                      right={(
                        <Tooltip title={unit.since || undefined}>
                          <Tag color={UNIT_COLOUR[unit.active] ?? 'default'} style={{ marginInlineEnd: 0 }}>
                            {unit.active === 'active' ? '執行中' : unit.active}
                          </Tag>
                        </Tooltip>
                      )}
                    />
                  ))}
                </div>
              </>
            ),
          },
        ]}
      />
    </Section>
  );
}

export default function Settings() {
  const owner = useIsOwner();
  const [settings, setSettings] = useState<Setting[] | null>(null);

  useEffect(() => {
    if (owner) fetchSettings().then(setSettings).catch(() => setSettings([]));
  }, [owner]);

  if (!owner) {
    return (
      <Alert
        type="info"
        showIcon
        message="這些設定由管理員管理"
        description="模型存放位置、對話與顯示卡的設定會影響這台機器上的每個人，只有管理員能看與修改。"
      />
    );
  }

  const byName = new Map((settings ?? []).map((s) => [s.name, s]));

  return (
    <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 1080 }}>
      <ModelLocationsCard />
      {SECTIONS.map((section) => (
        <Section key={section.title} title={section.title} note={section.note}>
          {settings === null && <Text type="secondary" style={{ fontSize: 12 }}>讀取中…</Text>}
          {section.names.map((name) => byName.get(name)).filter((s): s is Setting => !!s).map((s) => (
            <SettingRow key={s.name} setting={s} onSaved={setSettings} />
          ))}
        </Section>
      ))}
      <Advanced />
    </Space>
  );
}
