import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Avatar, Button, Card, Collapse, Empty, Image, InputNumber,
  Progress, Select, Space, Switch, Tag, Tooltip, Typography,
} from 'antd';
import {
  ClearOutlined, CopyOutlined, DownOutlined, RedoOutlined, RobotOutlined, UserOutlined,
} from '@ant-design/icons';
import Composer from '../components/Composer';
import {
  chatStream, fetchModels,
  type ChatMessage, type ModelInfo, type Timings, type Usage,
} from '../api';

const { Text, Paragraph } = Typography;

/** Starter prompts, so an empty thread is not a blank wall. */
const SUGGESTIONS = [
  '用三句話解釋 MoE 模型',
  '寫一個 Python 函式，計算費氏數列',
  '這台機器適合跑多大的模型？',
];

interface Turn extends ChatMessage {
  usage?: Usage;
  timings?: Timings;
  /** 'length' means the reply was cut off at max tokens, not finished. */
  finish_reason?: string;
  /** Time to first token, measured in the browser -- the one number that is
   *  legitimately client-side, because it is what the user actually waits. */
  ttft_ms?: number;
}

function renderContent(text: string) {
  const parts = text.split(/```/);
  return parts.map((part, index) => {
    if (index % 2 === 0) {
      return <span key={index} style={{ whiteSpace: 'pre-wrap' }}>{part}</span>;
    }
    const newline = part.indexOf('\n');
    const body = newline >= 0 ? part.slice(newline + 1) : part;
    const language = newline >= 0 ? part.slice(0, newline).trim() : '';
    return (
      <pre key={index} style={{
        background: 'rgba(128,128,128,0.16)', padding: 12, borderRadius: 6,
        overflowX: 'auto', margin: '8px 0', fontSize: 13, lineHeight: 1.55,
      }}>
        {language && <div style={{ opacity: 0.55, fontSize: 11, marginBottom: 6 }}>{language}</div>}
        <code>{body}</code>
      </pre>
    );
  });
}

/** Server-measured stats for one reply. */
function TurnStats({ turn }: { turn: Turn }) {
  const t = turn.timings;
  if (!t && !turn.usage) return null;

  const bits: string[] = [];
  if (t) {
    bits.push(`生成 ${t.predicted_n} tok ・ ${t.predicted_per_second.toFixed(1)} t/s`);
    bits.push(`prompt ${t.prompt_n} tok ・ ${t.prompt_per_second.toFixed(0)} t/s`);
    if (t.cache_n > 0) bits.push(`快取命中 ${t.cache_n} tok`);
  } else if (turn.usage) {
    bits.push(`${turn.usage.completion_tokens} tok`);
  }
  if (turn.ttft_ms !== undefined) bits.push(`首字 ${(turn.ttft_ms / 1000).toFixed(2)} s`);

  return (
    <Tooltip title="數字取自 llama-server 的內部計時，不含網路與排隊時間">
      <Text type="secondary" style={{ fontSize: 11 }}>{bits.join(' ・ ')}</Text>
    </Tooltip>
  );
}

export default function Chat() {
  const { message: toast } = AntApp.useApp();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [atBottom, setAtBottom] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchModels()
      .then((list) => { setModels(list); setModel((c) => c ?? list[0]?.id); })
      .catch(() => undefined);
  }, []);

  // Stick to the bottom only while the reader is already there. Yanking the
  // view down while someone is reading earlier output is the single most
  // annoying thing a streaming chat can do.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, []);

  useLayoutEffect(() => {
    if (atBottom && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [turns, atBottom]);

  const run = useCallback(async (history: Turn[]) => {
    if (!model) return;
    setTurns([...history, { role: 'assistant', content: '', reasoning: '' }]);
    setStreaming(true);
    setAtBottom(true);

    const controller = new AbortController();
    abort.current = controller;
    const startedAt = performance.now();
    let ttft: number | undefined;

    try {
      for await (const delta of chatStream({
        model, messages: history, temperature, maxTokens, thinking,
        signal: controller.signal,
      })) {
        if ((delta.content || delta.reasoning) && ttft === undefined) {
          ttft = performance.now() - startedAt;
        }
        setTurns((prev) => {
          const next = [...prev];
          const last = { ...next[next.length - 1] };
          if (delta.content) last.content += delta.content;
          if (delta.reasoning) last.reasoning = (last.reasoning ?? '') + delta.reasoning;
          if (delta.usage) last.usage = delta.usage;
          if (delta.timings) last.timings = delta.timings;
          if (delta.finish_reason) last.finish_reason = delta.finish_reason;
          if (ttft !== undefined) last.ttft_ms = ttft;
          next[next.length - 1] = last;
          return next;
        });
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        toast.error((error as Error).message);
        // Drop the empty assistant turn so a retry does not send a blank reply
        // back as context.
        setTurns((prev) => (prev[prev.length - 1]?.content ? prev : prev.slice(0, -1)));
      }
    } finally {
      setStreaming(false);
      abort.current = null;
    }
  }, [model, temperature, maxTokens, thinking, toast]);

  const send = useCallback((text?: string) => {
    const content = (text ?? draft).trim();
    // An image on its own is a valid message; text is only required when there
    // is nothing else to send.
    if ((!content && images.length === 0) || !model || streaming) return;
    setDraft('');
    setImages([]);
    void run([...turns, {
      role: 'user',
      content: content || '請描述這張圖片。',
      images: images.length ? images : undefined,
    }]);
  }, [draft, images, model, streaming, turns, run]);

  const regenerate = useCallback(() => {
    const lastUser = [...turns].reverse().findIndex((t) => t.role === 'user');
    if (lastUser < 0) return;
    void run(turns.slice(0, turns.length - lastUser));
  }, [turns, run]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已複製');
    } catch {
      toast.warning('瀏覽器不允許複製（純 HTTP 下會被擋），請手動選取');
    }
  };

  const active = models.find((m) => m.id === model);
  const ctxLimit = active?.ctx_size ?? 0;
  // The last reply's usage covers the whole prompt, so it is the current
  // occupancy of the context window rather than a per-message figure.
  const lastUsage = [...turns].reverse().find((t) => t.usage)?.usage;
  const ctxUsed = lastUsage ? (lastUsage.prompt_tokens + lastUsage.completion_tokens) : 0;
  const ctxPercent = ctxLimit ? Math.min(100, Math.round((ctxUsed / ctxLimit) * 100)) : 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {models.length === 0 && (
        <Alert type="info" showIcon message="尚未設定任何模型"
               description="請先到「模型」頁新增，才能在這裡對話。" />
      )}

      <Card size="small">
        <Space wrap size={16} style={{ width: '100%' }}>
          <Space size={8}>
            <Select
              value={model}
              onChange={setModel}
              style={{ minWidth: 250 }}
              options={models.map((m) => ({ value: m.id, label: m.name || m.id }))}
            />
            {active && <Tag color={active.state === 'ready' ? 'green' : 'default'}>{active.state}</Tag>}
          </Space>
          <Space size={8}>
            <Text type="secondary">思考</Text>
            <Switch size="small" checked={thinking} onChange={setThinking} />
          </Space>
          <Space size={8}>
            <Text type="secondary">temp</Text>
            <InputNumber size="small" min={0} max={2} step={0.1} value={temperature}
                         onChange={(v) => setTemperature(v ?? 0.7)} style={{ width: 72 }} />
          </Space>
          <Space size={8}>
            <Text type="secondary">max tokens</Text>
            <InputNumber size="small" min={16} max={65536} step={256} value={maxTokens}
                         onChange={(v) => setMaxTokens(v ?? 2048)} style={{ width: 92 }} />
          </Space>
          <Button size="small" icon={<ClearOutlined />} disabled={!turns.length || streaming}
                  onClick={() => setTurns([])}>
            清空
          </Button>
        </Space>

        {ctxLimit > 0 && (
          <div style={{ marginTop: 10 }}>
            <Space size={8} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                Context {ctxUsed.toLocaleString()} / {ctxLimit.toLocaleString()}
              </Text>
              <Progress
                percent={ctxPercent}
                size="small"
                showInfo={false}
                status={ctxPercent > 90 ? 'exception' : 'normal'}
                style={{ width: 220 }}
              />
            </Space>
          </div>
        )}

        {thinking && (
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            思考模式下模型可能把整個 token 預算用在推理上而回傳空答案，
            工具呼叫也可能完全產不出來。遇到請調高 max tokens 或關掉。
          </Paragraph>
        )}
      </Card>

      <div style={{ position: 'relative' }}>
        <Card size="small" styles={{ body: { padding: 16 } }}>
          <div
            ref={scroller}
            onScroll={onScroll}
            style={{ minHeight: '42vh', maxHeight: '58vh', overflowY: 'auto', paddingRight: 4 }}
          >
            {turns.length === 0 ? (
              <div style={{ paddingTop: 32 }}>
                <Empty description="開始對話以測試模型" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                <Space wrap size={8} style={{ justifyContent: 'center', width: '100%', marginTop: 12 }}>
                  {SUGGESTIONS.map((s) => (
                    <Button key={s} size="small" onClick={() => send(s)} disabled={!model}>
                      {s}
                    </Button>
                  ))}
                </Space>
              </div>
            ) : (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                {turns.map((turn, index) => {
                  const isUser = turn.role === 'user';
                  const isLast = index === turns.length - 1;
                  return (
                    <div key={index} style={{
                      display: 'flex', gap: 10,
                      flexDirection: isUser ? 'row-reverse' : 'row',
                    }}>
                      <Avatar
                        size={28}
                        icon={isUser ? <UserOutlined /> : <RobotOutlined />}
                        style={{ flexShrink: 0, background: isUser ? '#1677ff' : 'rgba(128,128,128,0.35)' }}
                      />
                      <div style={{ maxWidth: '80%', minWidth: 0 }}>
                        <div style={{
                          background: isUser ? 'rgba(22,119,255,0.16)' : 'rgba(128,128,128,0.11)',
                          padding: '10px 14px', borderRadius: 10,
                        }}>
                          {turn.reasoning ? (
                            <Collapse
                              ghost
                              size="small"
                              // Open while it is the thing currently streaming,
                              // closed once the answer itself has arrived.
                              defaultActiveKey={isLast && streaming && !turn.content ? ['r'] : []}
                              style={{ marginBottom: turn.content ? 8 : 0 }}
                              items={[{
                                key: 'r',
                                label: <Text type="secondary" style={{ fontSize: 12 }}>思考過程</Text>,
                                children: (
                                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                                    {turn.reasoning}
                                  </Text>
                                ),
                              }]}
                            />
                          ) : null}
                          {turn.images?.length ? (
                            <Space wrap size={6} style={{ marginBottom: 8 }}>
                              {turn.images.map((src, i) => (
                                <Image key={i} src={src} width={110}
                                       style={{ borderRadius: 6 }} />
                              ))}
                            </Space>
                          ) : null}
                          {renderContent(turn.content)}
                          {isLast && streaming && !turn.content && !turn.reasoning && (
                            <Text type="secondary" style={{ fontSize: 12 }}>思考中…</Text>
                          )}
                          {turn.finish_reason === 'length' && (
                            <div style={{ marginTop: 8 }}>
                              <Tooltip title={`回覆在 ${maxTokens} tokens 處被切斷，不是模型講完了。調高上方的 max tokens 後重新生成即可取得完整內容。`}>
                                <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                                  已達 max tokens 上限，內容被截斷
                                </Tag>
                              </Tooltip>
                            </div>
                          )}
                        </div>

                        <Space size={4} style={{ marginTop: 4 }} wrap>
                          <Tooltip title="複製">
                            <Button type="text" size="small" icon={<CopyOutlined />}
                                    onClick={() => copy(turn.content)} />
                          </Tooltip>
                          {!isUser && isLast && !streaming && (
                            <Tooltip title="重新生成">
                              <Button type="text" size="small" icon={<RedoOutlined />}
                                      onClick={regenerate} />
                            </Tooltip>
                          )}
                          {!isUser && <TurnStats turn={turn} />}
                        </Space>
                      </div>
                    </div>
                  );
                })}
              </Space>
            )}
          </div>
        </Card>

        {!atBottom && (
          <Button
            shape="circle"
            icon={<DownOutlined />}
            style={{ position: 'absolute', right: 24, bottom: 16 }}
            onClick={() => {
              setAtBottom(true);
              if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
            }}
          />
        )}
      </div>

      <Card size="small">
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => send()}
          onStop={() => abort.current?.abort()}
          streaming={streaming}
          disabled={!model}
          capabilities={active?.capabilities}
          images={images}
          onImagesChange={setImages}
        />
      </Card>
    </Space>
  );
}
