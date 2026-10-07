import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Drawer, Popconfirm, Result, Select, Space, Spin, Tag, Typography,
} from 'antd';
import {
  CheckCircleOutlined, InfoCircleOutlined, WarningOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  benchPlan, startBench, type BenchPlan, type BenchTier, type ModelInfo,
} from '../../api';
import { useStream } from '../../stream';
import { benchActive, useBenchStatus } from '../../benchState';
import { useNarrow } from '../Sidebar';
import { ACCENT, LINE, MONO } from '../../theme';
import BenchProgressView from './BenchProgressView';
import { CaseName, ResultsTable } from './BenchResults';
import BenchReport from './BenchReport';
import {
  TIERS, caseLabel, fmtDuration, fmtEstimate, parseSkipped, sortCases, tierLabel,
} from './labels';

const { Text, Paragraph } = Typography;

/** While the confirmation is on screen, the plan is asked again this often:
 *  the in-flight count and ComfyUI's queue change under it. */
const PLAN_REFRESH_MS = 5000;

const TIER_TEXT: Record<BenchTier, string> = {
  quick: '1k 深度、1 與 4 路、三種內容，各跑 1 次。調參數時用。',
  full: '1k／8k／32k／64k／128k 深度、1／2／4 路、三種內容，各跑 3 次取平均（64k、128k 各 1 次）。超過模型上下文的深度會略過。正式比較時用。',
};

/** One line of "what will happen", marked by whether it is worth a second look. */
function Consequence({ tone, children }: { tone: 'ok' | 'info' | 'warn'; children: React.ReactNode }) {
  const icon = tone === 'warn'
    ? <WarningOutlined style={{ color: ACCENT.warn }} />
    : tone === 'ok'
      ? <CheckCircleOutlined style={{ opacity: 0.55 }} />
      : <InfoCircleOutlined style={{ opacity: 0.55 }} />;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 0' }}>
      <span style={{ flex: 'none', width: 14 }}>{icon}</span>
      <div style={{ minWidth: 0, fontSize: 13, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontSize: 12, letterSpacing: 1, opacity: 0.55, display: 'block', margin: '20px 0 8px' }}>
      {children}
    </Text>
  );
}

/** Two cards, one per tier, the same size whichever is chosen. */
function TierChoice({ value, onChange, plans }: {
  value: BenchTier; onChange: (t: BenchTier) => void; plans: Partial<Record<BenchTier, BenchPlan>>;
}) {
  return (
    <div role="radiogroup" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      {TIERS.map((t) => {
        const on = t === value;
        const plan = plans[t];
        return (
          <button
            key={t} type="button" role="radio" aria-checked={on}
            onClick={() => onChange(t)}
            style={{
              // A button centres its content; a card reads from the top, and
              // the two cards' lines must start level whatever wraps.
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
              textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit',
              padding: '12px 14px', borderRadius: 6,
              border: `1px solid ${on ? 'rgba(255,255,255,0.75)' : LINE.soft}`,
              background: on ? 'rgba(255,255,255,0.06)' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
              <Text strong style={{ fontSize: 15 }}>{tierLabel(t)}</Text>
              <Text style={{ fontFamily: MONO, fontSize: 12, opacity: 0.7 }}>
                {plan ? fmtEstimate(plan.estimated_s) : '…'}
              </Text>
            </div>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4, lineHeight: 1.5 }}>
              {TIER_TEXT[t]}
            </Text>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4, fontFamily: MONO }}>
              {plan ? `${plan.cases.length} 項` : ' '}
            </Text>
          </button>
        );
      })}
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

function Before({ plan, plans, tier, onTier, error, models, chosen, onChoose, onModels }: {
  plan?: BenchPlan; plans: Partial<Record<BenchTier, BenchPlan>>;
  tier: BenchTier; onTier: (t: BenchTier) => void; error: string | null;
  models: ModelInfo[]; chosen?: string; onChoose: (id: string) => void; onModels: () => void;
}) {
  const skipped = (plan?.skipped ?? []).map(parseSkipped);
  // The ones running, and the chosen one should it stop while this is open,
  // so the choice does not blank out under the person making it.
  const running = models.filter((m) => m.running || m.id === chosen);
  return (
    <div>
      <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 16 }}>
        用一組固定的測試量一個模型在這台機器上有多快：第一個字要等多久（TTFT）、
        讀入提示多快（Prefill）、每秒生成幾個字（Decode），以及上下文變長或多人同時用時慢多少。
        結果會存進跑分紀錄，改了參數再跑一次，就能並排比較。
      </Paragraph>

      <SectionTitle>選擇模型</SectionTitle>
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

      <SectionTitle>選擇檔次</SectionTitle>
      <TierChoice value={tier} onChange={onTier} plans={plans} />

      {error && <Alert type="error" showIcon style={{ marginTop: 16 }} message="讀不到跑分計畫" description={error} />}

      {!plan && !error && (
        <div style={{ padding: 32, textAlign: 'center' }}><Spin /></div>
      )}

      {plan && (
        <>
          <SectionTitle>開始後會發生什麼</SectionTitle>
          <Consequence tone={plan.loaded ? 'ok' : 'info'}>
            {plan.loaded
              ? '模型已經載入，直接開跑。'
              : '模型目前沒有載入，會先載入（冷啟動）。載入時間另外記錄，不算進速度。'}
          </Consequence>
          <Consequence tone={plan.unloads.length ? 'warn' : 'ok'}>
            {plan.unloads.length ? (
              <>
                會卸載
                {plan.unloads.map((m) => (
                  <Tag key={m} style={{ fontFamily: MONO, fontSize: 11, marginInline: 4 }}>{m}</Tag>
                ))}
                ，正在用它們的人會中斷。
              </>
            ) : '不需要卸載其他模型。'}
          </Consequence>
          <Consequence tone="warn">
            跑分期間對外 API 暫停（{fmtEstimate(plan.estimated_s)}），其他程式和對話頁的請求會收到「暫停中」。
            {plan.in_flight > 0
              ? <> 目前有 <Text strong>{plan.in_flight}</Text> 個請求進行中，會先等它們結束。</>
              : ' 目前沒有進行中的請求。'}
          </Consequence>
          {plan.comfy_busy && (
            <Consequence tone="warn">
              ComfyUI 正在出圖，和模型用同一張卡，成績會偏低。建議等它結束再跑。
            </Consequence>
          )}

          <SectionTitle>測試項目（{plan.cases.length} 項）</SectionTitle>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            {plan.context > 0
              ? <>模型上下文 <Text style={{ fontFamily: MONO, fontSize: 12 }}>{plan.context.toLocaleString()}</Text> tokens
                  {plan.context_served ? '（模型回報）' : '（從啟動參數讀到）'}，超過的深度會略過。</>
              : '讀不到模型的上下文長度，所有深度都會試跑；超過的會失敗並略過。'}
          </Text>
          <Space size={[6, 6]} wrap>
            {sortCases(plan.cases, (c) => c).map((c) => (
              <Tag key={c} style={{ marginInlineEnd: 0 }}><CaseName id={c} /></Tag>
            ))}
          </Space>
          {skipped.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {skipped.map((s) => (
                <Text key={s.id} type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  略過 {caseLabel(s.id)}{s.reason ? `：${s.reason}` : ''}
                </Text>
              ))}
            </div>
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
  const [tier, setTier] = useState<BenchTier>('quick');
  const [plans, setPlans] = useState<Partial<Record<BenchTier, BenchPlan>>>({});
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
    setPlans({});
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

  const loadPlans = useCallback(() => {
    if (!id) return;
    Promise.all(TIERS.map((t) => benchPlan(id, t)))
      .then(([quick, full]) => { setPlans({ quick, full }); setPlanError(null); })
      .catch((e: Error) => setPlanError(e.message));
  }, [id]);

  useEffect(() => {
    if (!id || view !== 'before') return;
    loadPlans();
    const timer = window.setInterval(loadPlans, PLAN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [id, view, loadPlans]);

  const plan = plans[tier];

  const start = async () => {
    if (!id) return;
    setStarting(true);
    try {
      await startBench(id, tier);
      setFollowing(true);
      await refresh();
    } catch (e) {
      message.error(`無法開始跑分：${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  };

  const confirmText = plan ? [
    `對外 API 會暫停${fmtEstimate(plan.estimated_s)}。`,
    plan.unloads.length ? `會卸載 ${plan.unloads.join('、')}。` : '',
    plan.in_flight > 0 ? `會先等 ${plan.in_flight} 個進行中的請求結束。` : '',
  ].filter(Boolean).join('') : '';

  let footer: React.ReactNode = null;
  if (view === 'before') {
    footer = (
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button onClick={onClose}>關閉</Button>
        <Popconfirm
          title={`開始${tierLabel(tier)}跑分？`}
          description={<div style={{ maxWidth: 300 }}>{confirmText}</div>}
          okText="開始" cancelText="先不要"
          onConfirm={start}
          disabled={!plan || plan.cases.length === 0}
        >
          <Button type="primary" loading={starting} disabled={!plan || plan.cases.length === 0}>
            開始跑分
          </Button>
        </Popconfirm>
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
        <Before plan={plan} plans={plans} tier={tier} onTier={setTier} error={planError}
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
                results: status.results, engine: plans[tier]?.engine || model?.provider_name,
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
