import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Input, Modal, Popconfirm, Select, Space, Switch, Tag, Tooltip,
  Typography,
} from 'antd';
import {
  CheckOutlined, DeleteOutlined, EditOutlined, LoadingOutlined, PlusOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import LocationForm from '../components/LocationForm';
import { Panel, Row } from '../components/Panel';
import { bytes } from '../components/files/kit';
import {
  addModelLocation, clearHuggingFace, fetchConfig, fetchHuggingFace, fetchMachine,
  fetchModelLocations, fetchSearchService, fetchSettings, locationName, removeModelLocation,
  restartSearch, saveConfigRaw, saveHuggingFace, saveSettings, setModelLocationDefaults,
  updateModelLocation,
  type HuggingFaceToken, type MachinePath, type MachineUnit, type ModelFormat, type ModelLocations,
  type SearchService, type Setting,
} from '../api';
import { useIsOwner } from '../identity';
import { ACCENT, LINE, MONO, SURFACE } from '../theme';

const { Text } = Typography;

/**
 * The console's own settings, for the administrator.
 *
 * One card per group, all the same width, in as many columns as fit; cards
 * side by side are the same height. Inside, a row is a name, one line saying
 * what it does, and its control on the right; a setting that needs more says
 * it behind the info mark beside its name, and so does a group beside its
 * title, so the page reads as a list of names rather than a wall of grey
 * text. What is large -- the llama-swap file -- opens in a dialog rather than
 * growing its card, so the grid stays even.
 *
 * The order is the one somebody setting the machine up meets them: where
 * models are kept, then downloading them, how chat behaves, how the cards are
 * shared with ComfyUI, and how much history is kept, then 進階. The versions of
 * what is installed are on the about page, beside the update they explain.
 *
 * Every control saves itself: a switch or a choice when it changes, a number
 * when the field is left. An apply button across a page of unrelated settings
 * made it easy to change three and keep none. The Hugging Face token is the
 * exception, because it is checked with the Hub before it is kept.
 */

const UNIT_COLOUR: Record<string, string> = {
  active: 'green', activating: 'orange', failed: 'red', inactive: 'default',
};

/** A row that says the group is still being read. */
function Reading() {
  return <Row label={<Text type="secondary" style={{ fontSize: 13 }}>讀取中…</Text>} />;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * A field that takes digits and nothing else. Every setting here is a whole
 * number from zero up, and InputNumber let letters and signs sit in the field
 * until it was left. Anything else typed or pasted is dropped as it arrives;
 * while an input method is composing -- a Chinese one turns number keys into
 * zhuyin -- the text is left alone, and cleaned when the word is committed.
 * The arrow keys step by one within the range.
 */
function DigitsInput({ value, min, max, onChange, onCommit }: {
  value: string; min: number; max: number;
  onChange: (text: string) => void; onCommit: () => void;
}) {
  const composing = useRef(false);
  const digits = (text: string) => text.replace(/\D/g, '').slice(0, String(max).length);
  const step = (by: number) => {
    const n = Number(value || 0) + by;
    onChange(String(Math.min(max, Math.max(min, n))));
  };
  return (
    <Input
      size="small"
      value={value}
      inputMode="numeric"
      autoComplete="off"
      style={{ width: 96 }}
      onChange={(e) => onChange(composing.current ? e.target.value : digits(e.target.value))}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(e) => { composing.current = false; onChange(digits(e.currentTarget.value)); }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
        if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
      }}
      onBlur={onCommit}
      onPressEnter={onCommit}
    />
  );
}

/**
 * One setting that saves itself. A 0/1 setting with no unit is a switch; a
 * number is kept as typed until the field is left or Enter is pressed, so
 * typing 4096 does not save 4, 40 and 409 on the way.
 */
function SettingRow({ setting, onSaved }: { setting: Setting; onSaved: (all: Setting[]) => void }) {
  const { message } = AntApp.useApp();
  const [draft, setDraft] = useState(String(setting.value));
  const [state, setState] = useState<SaveState>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => { setDraft(String(setting.value)); }, [setting.value]);
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
      setDraft(String(setting.value));
      message.error((error as Error).message);
    }
  };

  // An empty field puts the saved value back; one outside the range is
  // pulled to the nearer end, and says what the range is.
  const commit = () => {
    const typed = draft === '' ? NaN : Number(draft);
    if (Number.isNaN(typed)) { setDraft(String(setting.value)); return; }
    const clamped = Math.min(setting.maximum, Math.max(setting.minimum, typed));
    if (clamped !== typed) {
      message.info(`範圍是 ${setting.minimum}–${setting.maximum}${setting.unit ? ` ${setting.unit}` : ''}`);
    }
    setDraft(String(clamped));
    void save(clamped);
  };

  const changed = setting.value !== setting.default;
  const fallback = toggle ? (setting.default ? '開' : '關') : `${setting.default} ${setting.unit}`;
  return (
    <Row
      label={setting.label}
      note={setting.note}
      detail={setting.detail}
      right={(
        <>
          {/* One slot of one width for saving, saved and 恢復預設, so the
              controls are as wide after a change as before it: wider, they
              no longer fit beside the name and the row broke onto two lines. */}
          <span style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            {state === 'saving' && <LoadingOutlined style={{ opacity: 0.6 }} />}
            {state === 'saved' && (
              <Tooltip title="已儲存"><CheckOutlined style={{ color: ACCENT.ok }} aria-label="已儲存" /></Tooltip>
            )}
            {state !== 'saving' && state !== 'saved' && changed && (
              <Tooltip title={`恢復預設（${fallback}）`}>
                <Button size="small" type="text" icon={<UndoOutlined />} aria-label="恢復預設"
                        onClick={() => { setDraft(String(setting.default)); void save(setting.default); }} />
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
            <>
              <DigitsInput
                value={draft}
                min={setting.minimum}
                max={setting.maximum}
                onChange={setDraft}
                onCommit={commit}
              />
              {/* One width for every unit, so the fields line up down the page. */}
              <Text type="secondary" style={{ fontSize: 12, width: 36 }}>{setting.unit}</Text>
            </>
          )}
        </>
      )}
    />
  );
}

const FORMATS: { key: ModelFormat; label: string; note: string }[] = [
  { key: 'gguf', label: 'GGUF 下載到', note: 'llama.cpp 用的模型檔' },
  { key: 'safetensors', label: 'safetensors 下載到', note: 'vLLM 與 SGLang 用的模型資料夾' },
];

/**
 * Where models live. A second disk for the large ones, or GGUF and
 * safetensors kept apart: each is a location, and each format has the one new
 * downloads of it land in. The primary is CONSOLE_MODELS_DIR and stays; the
 * others can go once no model loads from them, and the files stay behind.
 */
function ModelLocationsGroup() {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<ModelLocations | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
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

  const info = 'llama.cpp、vLLM 與 SGLang 都從這些位置讀模型。移除一個位置只是不再使用，資料夾裡的檔案會留著。';
  if (!data) {
    return <Panel title="模型存放" info={info}><Reading /></Panel>;
  }
  const locations = data.locations;
  const full = locations.length >= data.max;
  const options = locations.map((l) => ({ value: l.key, label: locationName(l) }));
  const models = locations.reduce((n, l) => n + l.models, 0);
  const used = locations.reduce((n, l) => n + l.used_bytes, 0);
  const trouble = locations.filter((l) => !l.exists || !l.writable).length;

  return (
    <Panel title="模型存放" info={info}>
        {FORMATS.map((f) => {
          const current = locations.find((l) => l.default_for.includes(f.key));
          return (
            <Row
              key={f.key}
              label={f.label}
              note={f.note}
              right={(
                <Tooltip title={locations.length < 2 ? '只有一個位置；新增位置後可以選' : undefined}>
                  <Select
                    size="small"
                    style={{ width: 200 }}
                    value={current?.key}
                    options={options}
                    disabled={busy || locations.length < 2}
                    onChange={(key) => run(() => setModelLocationDefaults({ [f.key]: key }), '已變更下載位置')}
                  />
                </Tooltip>
              )}
            />
          );
        })}
        <Row
          label="存放位置"
          note={`${locations.length} 個位置・${models} 個模型・${bytes(used)}`}
          right={(
            <>
              {trouble > 0 && <Tag color="warning" style={{ marginInlineEnd: 0 }}>{trouble} 個有問題</Tag>}
              <Button size="small" onClick={() => setManaging(true)}>管理</Button>
            </>
          )}
        />

      <Modal
        title="存放位置"
        open={managing}
        width={760}
        footer={null}
        onCancel={() => { setManaging(false); setAdding(false); setEditing(null); }}
      >
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12, lineHeight: 1.7 }}>
          {info}
        </Text>
        <div className="settings-box" style={{ border: `1px solid ${LINE.faint}`, borderRadius: 6, overflow: 'hidden' }}>
          {locations.map((loc) => {
            const blocked = loc.primary || loc.in_use.length > 0;
            const why = loc.primary
              ? '主要位置不能移除'
              : loc.in_use.length > 0
                ? `還有模型從這裡載入：${loc.in_use.join('、')}`
                : undefined;
            if (editing === loc.key) {
              return (
                <div key={loc.key} style={{ padding: '12px 16px' }}>
                  <LocationForm
                    initialPath={loc.path}
                    initialLabel={loc.label}
                    lockPath={loc.primary}
                    busy={busy}
                    submit="儲存"
                    onSubmit={(path, label) => onEdit(loc.key, path, label, loc.primary)}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              );
            }
            return (
              <Row
                key={loc.key}
                label={(
                  <>
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
                  </>
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
                      <Button size="small" type="text" icon={<EditOutlined />} aria-label="編輯"
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
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="移除"
                                disabled={blocked || busy} />
                      </Popconfirm>
                    </Tooltip>
                  </Space>
                )}
              />
            );
          })}
          {adding ? (
            <div style={{ padding: '12px 16px' }}>
              <LocationForm busy={busy} submit="加入" onSubmit={onAdd} onCancel={() => setAdding(false)} />
            </div>
          ) : (
            <Tooltip title={full ? `最多 ${data.max} 個位置` : undefined}>
              <Button className="settings-add" type="text" icon={<PlusOutlined />}
                      disabled={full || editing !== null} onClick={() => setAdding(true)}>
                新增位置
              </Button>
            </Tooltip>
          )}
        </div>
      </Modal>
    </Panel>
  );
}

/**
 * The owner's Hugging Face token. The catalog sends it to reach gated models
 * (Llama, Gemma, …) once the owner has accepted their terms on the Hub; it is
 * checked with the Hub before it is kept, and never shown again -- only whose
 * it is and its last four characters.
 */
function HuggingFaceRow() {
  const { message } = AntApp.useApp();
  const [state, setState] = useState<HuggingFaceToken | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    fetchHuggingFace().then(setState).catch(() => setState({ set: false, hint: '', user: '' }));
  }, []);

  const save = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      const next = await saveHuggingFace(draft.trim());
      setState(next);
      setEditing(false);
      setDraft('');
      message.success(next.user ? `已儲存 ${next.user} 的 token` : '已儲存');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    try {
      setState(await clearHuggingFace());
      message.success('已移除');
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const set = !!state?.set;
  return (
    <Row
      label="Hugging Face token"
      note={state === null
        ? '讀取中…'
        : set
          ? <>屬於 <b>{state.user || '（讀不到帳號）'}</b>・{state.hint}</>
          : '下載需要授權的模型（Llama、Gemma 等）時用'}
      detail={(
        <>
          到 <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">huggingface.co/settings/tokens</a>{' '}
          建立一個權限是 Read 的 token。儲存前會先向 Hugging Face 確認它有效，只存在這台機器上，不會再顯示出來。
          需要授權的模型，還要先到它的模型頁同意使用條款。
        </>
      )}
      right={state !== null && !editing && (
        set ? (
          <>
            <Button size="small" onClick={() => setEditing(true)}>更換</Button>
            <Popconfirm title="移除 token？" description="需要授權的模型就下載不了了。"
                        okText="移除" cancelText="取消" onConfirm={() => void remove()}>
              <Button size="small" danger>移除</Button>
            </Popconfirm>
          </>
        ) : (
          <Button size="small" onClick={() => setEditing(true)}>設定</Button>
        )
      )}
    >
      {editing && (
        <Space wrap>
          <Space.Compact style={{ width: 360, maxWidth: '100%' }}>
            <Input.Password
              placeholder="hf_…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPressEnter={() => void save()}
              autoComplete="off"
              autoFocus
            />
            <Button type="primary" loading={saving} disabled={!draft.trim()} onClick={() => void save()}>
              儲存
            </Button>
          </Space.Compact>
          <Button onClick={() => { setEditing(false); setDraft(''); }}>取消</Button>
        </Space>
      )}
    </Row>
  );
}

/**
 * The web search the agent uses, and a way to bring it back. It is a
 * container of its own, and when it stops the chat quietly stops offering
 * search -- so whether it answers is said here, beside the agent's settings,
 * rather than on a page of containers.
 */
function SearchServiceRow() {
  const { message } = AntApp.useApp();
  const [svc, setSvc] = useState<SearchService | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchSearchService().then(setSvc).catch(() => setSvc(null));
  }, []);
  useEffect(load, [load]);

  const restart = async () => {
    setBusy(true);
    try {
      await restartSearch();
      message.success('已重啟搜尋服務');
      // SearXNG takes a few seconds to answer after it starts.
      window.setTimeout(load, 4000);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!svc) return null;
  const tag = svc.available
    ? <Tag color="green" style={{ marginInlineEnd: 0 }}>可以使用</Tag>
    : svc.installed
      ? <Tag color="error" style={{ marginInlineEnd: 0 }}>沒有回應</Tag>
      : <Tag style={{ marginInlineEnd: 0 }}>未安裝</Tag>;
  return (
    <Row
      label="網頁搜尋"
      note={svc.installed ? '讓 Agent 能上網查資料（SearXNG）' : '沒有安裝 SearXNG，對話頁不會提供搜尋'}
      detail={svc.installed
        ? <>停掉時對話頁不會提供搜尋工具。服務：<span style={{ fontFamily: MONO }}>{svc.unit ?? svc.container}</span></>
        : '用 install.sh --searxng 重新安裝即可加上。'}
      right={(
        <>
          <Tooltip title={svc.since || undefined}>{tag}</Tooltip>
          {svc.installed && (
            <Button size="small" loading={busy} onClick={() => void restart()}>重啟</Button>
          )}
        </>
      )}
    />
  );
}

/** A plain line in the paths dialog: a name, a value, something on the right. */
function Item({ label, value, right }: { label: React.ReactNode; value?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4,
      padding: '8px 0', borderTop: `1px solid ${LINE.faint}`,
    }}>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {value && <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO, overflowWrap: 'anywhere' }}>{value}</Text>}
      </div>
      {right}
    </div>
  );
}

/**
 * What is here for the rare occasion: the whole llama-swap file, and where
 * this install lives. Each opens in a dialog, and is read only then.
 */
function AdvancedGroup() {
  const { message, modal } = AntApp.useApp();
  const [open, setOpen] = useState<'config' | 'machine' | null>(null);
  const [raw, setRaw] = useState('');
  const [original, setOriginal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [paths, setPaths] = useState<MachinePath[] | null>(null);
  const [units, setUnits] = useState<MachineUnit[]>([]);

  // Read afresh each time it opens: the models page writes the same file.
  const openConfig = () => {
    setOpen('config');
    fetchConfig().then((c) => { setRaw(c.raw); setOriginal(c.raw); })
      .catch((e) => message.error((e as Error).message));
  };
  const openMachine = () => {
    setOpen('machine');
    fetchMachine().then((m) => { setPaths(m.paths); setUnits(m.units); }).catch(() => setPaths([]));
  };

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
    <Panel title="進階" info="平常用不到的東西。">
      <Row
        label="llama-swap 設定檔"
        note="所有模型設定最後都寫進這裡；改錯可能讓模型全部載入不了"
        detail="「模型」頁與這一頁的修改最後都會寫進這個檔案。儲存後會等 llama-swap 確認：它不接受的內容會自動還原，不會留在檔案裡。原檔備份為 config.yaml.bak。"
        right={<Button size="small" onClick={openConfig}>編輯</Button>}
      />
      <Row
        label="路徑與服務"
        note="這次安裝放在哪裡、跑著哪些服務"
        detail="路徑由環境變數設定，這裡只顯示。"
        right={<Button size="small" onClick={openMachine}>查看</Button>}
      />

      <Modal
        title="llama-swap 設定檔"
        open={open === 'config'}
        width={960}
        onCancel={() => {
          if (!dirty) { setOpen(null); return; }
          modal.confirm({
            title: '還沒儲存，確定關閉？',
            content: '這次的修改會不見。',
            okText: '關閉', cancelText: '繼續編輯', okButtonProps: { danger: true },
            onOk: () => { setRaw(original ?? ''); setOpen(null); },
          });
        }}
        footer={(
          <Space>
            <Button disabled={!dirty} onClick={() => setRaw(original ?? '')}>還原</Button>
            <Button type="primary" loading={saving} disabled={!dirty} onClick={onSave}>儲存</Button>
          </Space>
        )}
      >
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10, lineHeight: 1.7 }}>
          儲存後會等 llama-swap 確認：它不接受的內容會自動還原，不會留在檔案裡。原檔備份為 config.yaml.bak。
        </Text>
        <textarea
          value={original === null ? '讀取中…' : raw}
          readOnly={original === null}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
          style={{
            width: '100%', height: '60vh', fontFamily: MONO, fontSize: 12, lineHeight: 1.5,
            padding: 12, borderRadius: 6, border: `1px solid ${LINE.faint}`,
            background: SURFACE.page, color: 'inherit', resize: 'vertical',
          }}
        />
      </Modal>

      <Modal
        title="路徑與服務"
        open={open === 'machine'}
        width={720}
        footer={null}
        onCancel={() => setOpen(null)}
      >
        {paths === null && <Text type="secondary">讀取中…</Text>}
        {(paths ?? []).map((path) => (
          <Item
            key={path.variable}
            label={<Space size={6}>{path.label}{!path.exists && <Tag color="warning">不存在</Tag>}</Space>}
            value={path.path}
            right={<Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>{path.variable}</Text>}
          />
        ))}
        {units.map((unit) => (
          <Item
            key={unit.name}
            label={<span style={{ fontFamily: MONO, fontSize: 12 }}>{unit.name.replace(/\.service$/, '')}</span>}
            value={unit.note}
            right={(
              <Tooltip title={unit.since || undefined}>
                <Tag color={UNIT_COLOUR[unit.active] ?? 'default'} style={{ marginInlineEnd: 0 }}>
                  {unit.active === 'active' ? '執行中' : unit.active}
                </Tag>
              </Tooltip>
            )}
          />
        ))}
      </Modal>
    </Panel>
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
  const rows = (...names: string[]) => (settings === null
    ? <Reading />
    : names
      .map((name) => byName.get(name))
      .filter((s): s is Setting => !!s)
      .map((s) => <SettingRow key={s.name} setting={s} onSaved={setSettings} />));

  // Filled row by row. The order pairs cards of like height -- the long
  // model locations beside chat -- so a row's shorter card is not left mostly
  // empty; one column reads in the order somebody setting up meets them.
  return (
    <div style={{
      display: 'grid', gap: 16, alignItems: 'stretch', paddingBottom: 24,
      gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 440px), 1fr))',
    }}>
      <ModelLocationsGroup />
      <Panel title="對話">
        {rows('agent_max_steps', 'vision_cache')}
        {settings !== null && <SearchServiceRow />}
      </Panel>
      <Panel title="模型目錄">
        <HuggingFaceRow />
        {rows('estimate_depth')}
      </Panel>
      <Panel title="顯示卡" info="LLM 與 ComfyUI 共用顯示卡時，用來判斷載入模型前要不要先停掉 ComfyUI。">
        {rows('vram_margin_gib', 'comfyui_idle_gib')}
      </Panel>
      <Panel title="紀錄保留" info="伺服器記住多少，給日誌頁與顯示卡頁往回看。">
        {rows('log_lines', 'gpu_history_hours')}
      </Panel>
      <AdvancedGroup />
    </div>
  );
}
