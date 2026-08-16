import { Button, Divider, Input, InputNumber, Slider, Space, Switch, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { DEFAULT_PARAMS, type ChatParams, type ModelInfo } from '../api';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * The sampling panel.
 *
 * Every control here maps to a field llama.cpp's server actually reads, so
 * nothing on this panel is decorative. Values start at the model's own
 * generation_config rather than at library defaults, because llama.cpp reads
 * those from the GGUF and a panel showing different numbers would be lying
 * about what is in effect.
 */

interface Props {
  params: ChatParams;
  onChange: (params: ChatParams) => void;
  model?: ModelInfo;
  /** Restore the model's configured sampling. Owned by the chat state, which is
   *  what seeds the panel in the first place. */
  onReset: () => void;
  /** Prompt + completion of the last reply: the window's real occupancy. */
  contextUsed: number;
}

function Row({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Tooltip title={hint} placement="left">
        <Text style={{ fontSize: 11, letterSpacing: 0.6, opacity: 0.55, display: 'block' }}>
          {label}
        </Text>
      </Tooltip>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

/** A slider paired with a number box: drag to explore, type to be exact. */
function Numeric({ value, onChange, min, max, step, suffix }: {
  value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; suffix?: string;
}) {
  return (
    <Space.Compact style={{ width: '100%' }} size="small">
      <Slider
        min={min} max={max} step={step} value={value} onChange={onChange}
        style={{ flex: 1, marginInline: '2px 10px' }} tooltip={{ open: false }}
      />
      <InputNumber
        size="small" min={min} max={max} step={step} value={value}
        onChange={(v) => onChange(v ?? value)}
        style={{ width: suffix ? 92 : 74, fontFamily: MONO }}
        suffix={suffix}
      />
    </Space.Compact>
  );
}

export default function ChatSettings({ params, onChange, model, onReset, contextUsed }: Props) {
  const set = <K extends keyof ChatParams>(key: K, value: ChatParams[K]) =>
    onChange({ ...params, [key]: value });

  const ctxLimit = model?.ctx_size ?? 0;
  // What seeding produces, so "already reset" is judged against the same thing
  // the reset button restores rather than against a constant.
  const configured: ChatParams = {
    ...DEFAULT_PARAMS,
    system: params.system,
    thinking: params.thinking,
    reasoning_budget_tokens: params.reasoning_budget_tokens,
    ...(model?.sampling ?? {}),
  };
  const ctxPercent = ctxLimit ? Math.min(100, (contextUsed / ctxLimit) * 100) : 0;

  return (
    <div style={{ padding: '4px 2px' }}>
      {ctxLimit > 0 && (
        <>
          <Row label="CONTEXT" hint="上一則回覆的 prompt + completion，也就是視窗目前的佔用">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ fontSize: 12, fontFamily: MONO }}>
                {contextUsed.toLocaleString()}
              </Text>
              <Text style={{ fontSize: 12, fontFamily: MONO, opacity: 0.45 }}>
                / {(ctxLimit / 1024).toFixed(0)}K
              </Text>
            </div>
            <div style={{ height: 2, background: LINE.faint, borderRadius: 1 }}>
              <div style={{
                height: '100%', width: `${ctxPercent}%`, borderRadius: 1,
                background: ctxPercent > 85 ? '#e0a83c' : 'rgba(255,255,255,0.75)',
                transition: 'width 300ms',
              }} />
            </div>
          </Row>
          <Divider style={{ margin: '14px 0' }} />
        </>
      )}

      <Row label="TEMPERATURE" hint="越低越保守。工具呼叫與程式碼建議 0.1–0.3">
        <Numeric value={params.temperature} onChange={(v) => set('temperature', v)}
                 min={0} max={2} step={0.05} />
      </Row>

      <Row
        label="MAX TOKENS"
        hint={ctxLimit
          ? `單次回覆的上限，思考模式會佔用同一份額度。上限跟著模型的 context（${(ctxLimit / 1024).toFixed(0)}K）走，實際還會被提示詞已佔用的部分再扣掉`
          : '單次回覆的上限。思考模式會佔用同一份額度'}
      >
        {/* Bounded by the model's own window rather than a fixed number: the
            two models here open 64K and 128K, so a hardcoded 32768 was capping
            the panel below what the server would actually accept. llama.cpp
            clamps n_predict to the context left after the prompt anyway, so
            this is the true ceiling. */}
        <Numeric value={params.max_tokens} onChange={(v) => set('max_tokens', v)}
                 min={64} max={ctxLimit || 32768} step={256} />
      </Row>

      <Divider style={{ margin: '14px 0' }}>
        <Text style={{ fontSize: 10, opacity: 0.35, letterSpacing: 1 }}>思考</Text>
      </Divider>

      <Row label="ENABLE THINKING" hint="模板層：是否開啟 <think> 區塊">
        <Space>
          <Switch size="small" checked={params.thinking}
                  onChange={(v) => set('thinking', v)} />
          <Text style={{ fontSize: 11, opacity: 0.5 }}>
            {params.thinking ? '開啟' : '關閉'}
          </Text>
        </Space>
      </Row>

      <Row
        label="REASONING BUDGET"
        hint="取樣層的硬上限，比模板開關可靠。-1 沿用伺服器設定，0 立即結束思考，N 為 token 上限"
      >
        {/* Thinking spends the same allowance the reply does, so a budget above
            max tokens could never be reached -- it follows that value instead
            of carrying a ceiling of its own. */}
        <Numeric value={params.reasoning_budget_tokens}
                 onChange={(v) => set('reasoning_budget_tokens', v)}
                 min={-1} max={params.max_tokens} step={128} />
      </Row>

      <Divider style={{ margin: '14px 0' }}>
        <Text style={{ fontSize: 10, opacity: 0.35, letterSpacing: 1 }}>取樣</Text>
      </Divider>

      <Row label="TOP P" hint="累積機率門檻">
        <Numeric value={params.top_p} onChange={(v) => set('top_p', v)}
                 min={0} max={1} step={0.01} />
      </Row>
      <Row label="TOP K" hint="每步只考慮機率最高的 K 個 token。0 表示不限制">
        <Numeric value={params.top_k} onChange={(v) => set('top_k', v)}
                 min={0} max={200} step={1} />
      </Row>
      <Row label="MIN P" hint="相對於最高機率的門檻，通常比 top_p 更穩定">
        <Numeric value={params.min_p} onChange={(v) => set('min_p', v)}
                 min={0} max={0.5} step={0.01} />
      </Row>
      <Row label="REPEAT PENALTY" hint="1.0 為不懲罰。過高會讓文字變得刻意迴避用詞">
        <Numeric value={params.repeat_penalty} onChange={(v) => set('repeat_penalty', v)}
                 min={1} max={1.5} step={0.01} />
      </Row>
      <Row label="SEED" hint="-1 為隨機。固定後同樣的輸入會得到同樣的輸出">
        <Numeric value={params.seed} onChange={(v) => set('seed', v)}
                 min={-1} max={999999} step={1} />
      </Row>

      <Divider style={{ margin: '14px 0' }}>
        <Text style={{ fontSize: 10, opacity: 0.35, letterSpacing: 1 }}>系統提示</Text>
      </Divider>

      <Input.TextArea
        value={params.system}
        onChange={(e) => set('system', e.target.value)}
        placeholder="留空則不送出 system 訊息"
        autoSize={{ minRows: 3, maxRows: 8 }}
        style={{ fontSize: 12 }}
      />

      {/* Back to what this model is configured with, not to a fixed set that
          may say something different from the config. What the button restores
          is what the panel started at, which is the only reset that is not a
          second opinion. */}
      <Button
        size="small" icon={<ReloadOutlined />} block
        style={{ marginTop: 14 }}
        onClick={() => onReset()}
        disabled={JSON.stringify(params) === JSON.stringify(configured)}
      >
        {model?.sampling ? '重設為模型設定值' : '重設為預設值'}
      </Button>

      {model?.sampling && (
        <Text style={{
          display: 'block', marginTop: 6, fontSize: 10, opacity: 0.4, lineHeight: 1.6,
        }}>
          取樣預設值來自 llama-swap 設定裡的 {model.id}
        </Text>
      )}
    </div>
  );
}
