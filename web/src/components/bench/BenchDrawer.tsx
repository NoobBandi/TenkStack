import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Drawer, Popconfirm, Result, Segmented, Select, Space, Tag, Tooltip, Typography,
} from 'antd';
import { CheckOutlined, InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  benchPlan, startBench, type BenchChoice, type BenchPlan, type BenchTier, type ModelInfo,
} from '../../api';
import { useStream } from '../../stream';
import { benchActive, useBenchStatus } from '../../benchState';
import { useNarrow } from '../Sidebar';
import { ACCENT, LINE, MONO } from '../../theme';
import BenchProgressView from './BenchProgressView';
import { ResultsTable } from './BenchResults';
import BenchReport from './BenchReport';
import {
  CASE_DEPTH, OPTIONAL_CASES, PICK_GROUPS, QUICK_CASES, caseHint, fmtDuration, fmtEstimate, tierLabel,
} from './labels';

const { Text } = Typography;

/** While the drawer is open, the plan is asked again this often: the
 *  in-flight count and ComfyUI's queue change under it. */
const PLAN_REFRESH_MS = 5000;

type Mode = BenchTier;
type Picks = { cases: string[]; repeats: number };

/** The tiers as picks: quick adds four people and two contents, once each;
 *  full adds everything, measured as often as the suite says. */
const PRESET: Record<'quick' | 'full', Picks> = {
  quick: { cases: OPTIONAL_CASES.filter((id) => QUICK_CASES.includes(id)), repeats: 1 },
  full: { cases: OPTIONAL_CASES, repeats: 0 },
};

const MODE_TEXT: Record<Mode, string> = {
  quick: '調參數時用：1k、1 與 4 人、三種內容，各 1 次。',
  full: '正式比較時用：所有長度、人數和內容，各 3 次取平均。',
  custom: '只跑勾選的項目。',
};

/** Whether a depth fits the model's context, as the server decides it:
 *  the depth, the answer and a little room for the template. */
const fits = (id: string, context: number) => !context || !CASE_DEPTH[id] || CASE_DEPTH[id] + 256 + 128 <= context;

/** The mode the picks amount to: a tier when they are exactly its picks
 *  among the cases this model can run, otherwise custom. */
function modeOf(p: Picks, context: number): Mode {
  const usable = (ids: string[]) => ids.filter((id) => fits(id, context)).sort().join();
  for (const tier of ['quick', 'full'] as const) {
    if (p.repeats === PRESET[tier].repeats && usable(p.cases) === usable(PRESET[tier].cases)) return tier;
  }
  return 'custom';
}

/** A line of what deserves a look before starting; only the cases that do. */
function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const icon = tone === 'warn'
    ? <WarningOutlined style={{ color: ACCENT.warn }} />
    : <InfoCircleOutlined style={{ opacity: 0.55 }} />;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0' }}>
      <span style={{ flex: 'none', width: 14 }}>{icon}</span>
      <div style={{ minWidth: 0, fontSize: 13, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function SectionTitle({ children, extra }: { children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, margin: '22px 0 10px' }}>
      <Text style={{ fontSize: 12, letterSpacing: 1, opacity: 0.55 }}>{children}</Text>
      {extra}
    </div>
  );
}

/** A case to add or leave out, as a chip: on, off, or greyed out with why. */
function Pick({ label, on, disabled, why, hint, onToggle, locked }: {
  label: string; on: boolean; disabled?: boolean; why?: string; hint?: string; onToggle?: () => void; locked?: boolean;
}) {
  const chip = (
    <button
      type="button" role="checkbox" aria-checked={on} aria-disabled={disabled || locked}
      onClick={disabled || locked ? undefined : onToggle}
      style={{
        font: 'inherit', fontSize: 13, color: 'inherit', padding: '4px 12px', borderRadius: 14, minWidth: 56,
        cursor: disabled || locked ? 'default' : 'pointer',
        border: `1px solid ${on ? 'rgba(255,255,255,0.7)' : LINE.soft}`,
        background: on ? 'rgba(255,255,255,0.1)' : 'transparent',
        opacity: disabled ? 0.35 : 1,
        textDecoration: disabled ? 'line-through' : undefined,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      {on && !disabled && <CheckOutlined style={{ fontSize: 11, marginInlineEnd: 6, opacity: locked ? 0.5 : 0.85 }} />}
      {label}
    </button>
  );
  const tip = why ?? hint;
  return tip ? <Tooltip title={tip} mouseEnterDelay={0.3}>{chip}</Tooltip> : chip;
}

/** The cases, by the report block that shows them: the base everyone gets,
 *  then what each block can add. */
function CasePicker({ picks, onChange, context }: {
  picks: Picks; onChange: (p: Picks) => void; context: number;
}) {
  const toggle = (id: string) => onChange({
    ...picks,
    cases: picks.cases.includes(id) ? picks.cases.filter((c) => c !== id) : [...picks.cases, id],
  });
  const row = (title: string, hint: string, chips: React.ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: 12, alignItems: 'center', padding: '7px 0' }}>
      <div>
        <div style={{ fontSize: 13 }}>{title}</div>
        <Text type="secondary" style={{ fontSize: 11 }}>{hint}</Text>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{chips}</div>
    </div>
  );
  return (
    <div style={{ borderTop: `1px solid ${LINE.faint}` }}>
      {row('單人對話', '每次都會測', (
        <Pick label="1 人・1k・英文" on locked hint="其他項目都拿它來比：長文比它慢多少、多人比它快幾倍、內容比它快慢。" />
      ))}
      {PICK_GROUPS.map((g) => (
        <div key={g.title} style={{ borderTop: `1px solid ${LINE.faint}` }}>
          {row(g.title, g.hint, g.items.map((item) => {
            const ok = fits(item.id, context);
            return (
              <Pick
                key={item.id} label={item.label}
                on={ok && picks.cases.includes(item.id)} disabled={!ok}
                why={ok ? undefined : `模型上下文只有 ${context.toLocaleString()} tokens，放不下`}
                hint={caseHint(item.id)}
                onToggle={() => toggle(item.id)}
              />
            );
          }))}
        </div>
      ))}
    </div>
  );
}

/**
 * Which model to run: only those running now. A benchmark measures a model
 * as it is serving, and starting one here would load it -- unloading whatever
 * else is in memory -- from a page that is not about models. The display
 * name, with the id under it: two quantisations of a model share the name
 * and only the id tells them apart.
 */
function ModelPicker({ models, value, onChange }: {
  models: ModelInfo[]; value?: string; onChange: (id: string) => void;
}) {
  return (
    <Select
      showSearch
      value={value}
      onChange={onChange}
      placeholder="選擇已啟動的模型"
      style={{ width: '100%' }}
      optionFilterProp="search"
      options={models.map((m) => ({
        value: m.id,
        search: `${m.name ?? ''} ${m.id}`,
        label: (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name || m.id}</span>
          </span>
        ),
        m,
      }))}
      optionRender={(option) => {
        const m = (option.data as { m: ModelInfo }).m;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name || m.id}</div>
              <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>{m.id}</Text>
            </div>
            {m.provider_name && <Text type="secondary" style={{ fontSize: 11 }}>{m.provider_name}</Text>}
          </div>
        );
      }}
    />
  );
}

/**
 * Before a run: the model, what to measure -- a tier as a starting point,
 * every case pickable by the block it shows up in -- how often, and only
 * then whatever deserves a look. The time and the start are in the footer.
 */
function Before({ plan, mode, onMode, picks, onPicks, error, models, chosen, onChoose, onModels }: {
  plan?: BenchPlan; mode: Mode; onMode: (m: Mode) => void; picks: Picks; onPicks: (p: Picks) => void;
  error: string | null;
  models: ModelInfo[]; chosen?: string; onChoose: (id: string) => void; onModels: () => void;
}) {
  // The ones running, and the chosen one should it stop while this is open,
  // so the choice does not blank out under the person making it.
  const running = models.filter((m) => m.running || m.id === chosen);
  const context = plan?.context ?? 0;
  return (
    <div>
      <SectionTitle>模型</SectionTitle>
      {running.length === 0 ? (
        <Alert
          type="info" showIcon
          message="目前沒有已啟動的模型"
          description="跑分只量正在運作的模型。先到「模型」頁啟動要測的模型，再回來開始跑分。"
          action={<Button size="small" onClick={onModels}>前往模型頁</Button>}
        />
      ) : (
        <>
          <ModelPicker models={running} value={chosen} onChange={onChoose} />
          {!chosen && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              只列出已啟動的模型。要測其他模型，先到「模型」頁啟動它。
            </Text>
          )}
        </>
      )}
      {!chosen ? null : (<>

      <SectionTitle extra={context > 0 && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          模型上下文 <span style={{ fontFamily: MONO }}>{context.toLocaleString()}</span> tokens
        </Text>
      )}>
        測什麼
      </SectionTitle>
      <Segmented<Mode>
        block value={mode} onChange={onMode}
        options={[
          { value: 'quick', label: '快速' },
          { value: 'full', label: '完整' },
          { value: 'custom', label: '自訂' },
        ]}
      />
      <Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '8px 0 10px' }}>{MODE_TEXT[mode]}</Text>
      <CasePicker picks={picks} onChange={onPicks} context={context} />

      <SectionTitle>每項跑幾次</SectionTitle>
      <Segmented<number>
        value={picks.repeats} onChange={(repeats) => onPicks({ ...picks, repeats })}
        options={[{ value: 1, label: '1 次' }, { value: 0, label: '3 次取平均' }]}
      />
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        {picks.repeats === 1 ? '比較快，數字會有一點起伏。' : '比較準，時間約三倍；64k、128k 仍只跑 1 次。'}
      </Text>

      {error && <Alert type="error" showIcon style={{ marginTop: 16 }} message="讀不到跑分計畫" description={error} />}

      {plan && (!plan.loaded || plan.unloads.length > 0 || plan.in_flight > 0 || plan.comfy_busy) && (
        <>
          <SectionTitle>開始前</SectionTitle>
          {!plan.loaded && (
            <Notice tone="info">模型目前沒有載入，會先載入（冷啟動）。載入時間另外記錄，不算進速度。</Notice>
          )}
          {plan.unloads.length > 0 && (
            <Notice tone="warn">
              會卸載
              {plan.unloads.map((m) => (
                <Tag key={m} style={{ fontFamily: MONO, fontSize: 11, marginInline: 4 }}>{m}</Tag>
              ))}
              ，正在用它們的人會中斷。
            </Notice>
          )}
          {plan.in_flight > 0 && (
            <Notice tone="info">目前有 <Text strong>{plan.in_flight}</Text> 個請求進行中，會先等它們結束。</Notice>
          )}
          {plan.comfy_busy && (
            <Notice tone="warn">ComfyUI 正在出圖，和模型用同一張卡，成績會偏低。建議等它結束再跑。</Notice>
          )}
        </>
      )}
      </>)}
    </div>
  );
}

/**
 * 跑分 for one model, from its row on the models page: the choice and what
 * it will cost before, the progress during, the results after.
 *
 * Which of the three it shows follows the console's bench status, not local
 * state alone: a run started elsewhere (another tab, another administrator)
 * holds /v1 just the same and is shown rather than offered a second start.
 */
export default function BenchDrawer({ open, onClose }: {
  open: boolean; onClose: () => void;
}) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { models } = useStream();
  const [chosen, setChosen] = useState<string | undefined>();
  const model = useMemo(() => models.find((m) => m.id === chosen) ?? null, [models, chosen]);
  const narrow = useNarrow();
  const { status, refresh } = useBenchStatus();
  const [picks, setPicks] = useState<Picks>(PRESET.quick);
  // What the tier buttons say: set by a click, then followed by the picks --
  // ticking the full tier's cases by hand lands on 完整 -- except that
  // 自訂, once clicked, stays until another tier is.
  const [chosenMode, setChosenMode] = useState<Mode>('quick');
  const [plan, setPlan] = useState<BenchPlan | undefined>();
  const [planError, setPlanError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Set once this drawer started (or watched) a run, so that when it ends the
  // drawer shows its results instead of going back to the confirmation.
  const [following, setFollowing] = useState(false);
  const id = chosen;

  const active = benchActive(status);
  const ended = status && ['done', 'failed', 'cancelled'].includes(status.state);
  const view: 'before' | 'during' | 'after' = active ? 'during'
    : following && ended && status?.model === id ? 'after' : 'before';

  // Opening starts on a model that is already loaded, when there is one: no
  // cold start, nothing unloaded. Otherwise nothing is chosen until the
  // person picks -- defaulting to a cold model would make the slow,
  // disruptive choice for them. Closing forgets the choice.
  const loaded = models.find((m) => m.running)?.id;
  // Only on the opening itself: a model loading later must not change a
  // choice already made.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setChosen(active && status?.model ? status.model : loaded);
    if (!open) setChosen(undefined);
    wasOpen.current = open;
  }, [open, active, status?.model, loaded]);

  // Opening for another model, or closing, starts over. Declared before the
  // effect below so that on opening it clears first and that one then sets.
  useEffect(() => {
    setPlan(undefined);
    setPlanError(null);
    setFollowing(false);
  }, [id]);

  // A run seen in progress is followed to its end even if this drawer did
  // not start it: its results are what the person is waiting for.
  useEffect(() => {
    if (!active || !status?.model) return;
    if (status.model !== id) { setChosen(status.model); return; }
    setFollowing(true);
  }, [active, status?.model, id]);

  const context = plan?.context ?? 0;
  const mode: Mode = chosenMode === 'custom' ? 'custom' : modeOf(picks, context);
  // What is sent: a tier by name when the picks are one, so its run is a
  // quick or full run, comparable with every other of its tier.
  const choice = useMemo<BenchChoice>(() => (mode === 'custom'
    ? { tier: 'custom', cases: picks.cases.filter((c) => fits(c, context)), repeats: picks.repeats }
    : { tier: mode }), [mode, picks, context]);
  const choiceKey = JSON.stringify(choice);

  const onMode = (m: Mode) => {
    setChosenMode(m);
    if (m !== 'custom') setPicks(PRESET[m]);
  };
  const onPicks = (p: Picks) => {
    setPicks(p);
    if (chosenMode !== 'custom') setChosenMode(modeOf(p, context));
  };

  // The plan for what is picked now; the last one stays on screen until the
  // next arrives, so the time in the footer changes rather than blinks.
  const loadPlan = useCallback(() => {
    if (!id) return;
    benchPlan(id, JSON.parse(choiceKey) as BenchChoice)
      .then((p) => { setPlan(p); setPlanError(null); })
      .catch((e: Error) => setPlanError(e.message));
  }, [id, choiceKey]);

  useEffect(() => {
    if (!id || view !== 'before') return;
    loadPlan();
    const timer = window.setInterval(loadPlan, PLAN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [id, view, loadPlan]);

  const start = async () => {
    if (!id) return;
    setStarting(true);
    try {
      await startBench(id, choice);
      setFollowing(true);
      await refresh();
    } catch (e) {
      message.error(`無法開始跑分：${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  // Asked again only when starting costs someone something: models
  // unloaded, or ComfyUI's work slowed and the scores with it.
  const disruptive = !!plan && (plan.unloads.length > 0 || plan.comfy_busy);
  const confirmText = plan ? [
    plan.unloads.length ? `會卸載 ${plan.unloads.join('、')}，正在用的人會中斷。` : '',
    plan.comfy_busy ? 'ComfyUI 正在出圖，成績會偏低。' : '',
  ].filter(Boolean).join('') : '';
  const ready = !!plan && plan.cases.length > 0 && !!id;
  const startButton = (
    <Button type="primary" loading={starting} disabled={!ready} onClick={disruptive ? undefined : start}>
      開始跑分
    </Button>
  );

  let footer: React.ReactNode = null;
  if (view === 'before') {
    footer = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, lineHeight: 1.4 }}>
          {plan && id && (
            <>
              <Text style={{ fontSize: 13 }}>
                {tierLabel(mode)}・{plan.cases.length} 項・<span style={{ fontFamily: MONO }}>{fmtEstimate(plan.estimated_s)}</span>
              </Text>
              <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>跑分期間對外 API 暫停，請求會收到「暫停中」</Text>
            </>
          )}
        </div>
        <Button onClick={onClose}>關閉</Button>
        {disruptive ? (
          <Popconfirm
            title="開始跑分？" description={<div style={{ maxWidth: 300 }}>{confirmText}</div>}
            okText="開始" cancelText="先不要" onConfirm={start} disabled={!ready}
          >
            {startButton}
          </Popconfirm>
        ) : startButton}
      </div>
    );
  } else if (view === 'after') {
    footer = (
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button onClick={() => setFollowing(false)}>再跑一次</Button>
        {status?.run_id !== undefined && status?.state === 'done' && (
          <Button type="primary" onClick={() => { onClose(); navigate(`/bench?run=${status.run_id}`); }}>
            在跑分紀錄查看
          </Button>
        )}
      </div>
    );
  }

  const title = model ? `跑分：${model.name || model.id}` : '跑分';

  return (
    <Drawer
      title={title}
      width={narrow ? '100%' : 760}
      open={open}
      onClose={onClose}
      footer={footer}
      destroyOnHidden
    >
      {view === 'before' && (
        <Before plan={plan} mode={mode} onMode={onMode} picks={picks} onPicks={onPicks} error={planError}
                models={models} chosen={chosen} onChoose={setChosen}
                onModels={() => { onClose(); navigate('/models'); }} />
      )}

      {view === 'during' && status && (
        <>
          {status.model !== id && (
            <Alert type="info" showIcon style={{ marginBottom: 16 }}
                   message={`另一個跑分正在進行（${status.model}），結束後才能開始新的。`} />
          )}
          <BenchProgressView status={status} showModel={status.model !== id} />
        </>
      )}

      {view === 'after' && status && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {status.state === 'done' && (
            <Result
              status="success" style={{ padding: '8px 0' }}
              title="跑分完成"
              subTitle={`${tierLabel(status.tier)}檔・${status.results?.length ?? 0} 項・用時 ${fmtDuration(status.elapsed_s)}`}
            />
          )}
          {status.state === 'failed' && (
            <Alert type="error" showIcon message="跑分失敗" description={status.error || status.message} />
          )}
          {status.state === 'cancelled' && (
            <Alert type="info" showIcon message="跑分已取消" description="對外 API 已經恢復。" />
          )}
          {(status.results?.length ?? 0) > 0 && (
            <>
              {/* The same report card as the 跑分 page, for the run just
                  finished; the table under it has every case. */}
              <BenchReport runs={[{
                key: 'run', mark: 0, name: model?.name || model?.id || status.model || '',
                results: status.results, engine: plan?.engine || model?.provider_name,
                tier: tierLabel(status.tier),
              }]} />
              <ResultsTable results={status.results} />
            </>
          )}
        </Space>
      )}
    </Drawer>
  );
}
