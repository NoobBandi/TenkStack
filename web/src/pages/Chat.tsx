import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Drawer, Empty, Grid, Image, Space, Tag,
  Tooltip, Typography,
} from 'antd';
import {
  CopyOutlined, DownOutlined, RedoOutlined, ReloadOutlined, SlidersOutlined,
} from '@ant-design/icons';
import Composer from '../components/Composer';
import ChatSettings from '../components/ChatSettings';
import PreviewPanel from '../components/PreviewPanel';
import { PreviewProvider, usePreview } from '../components/preview';
import ChatHistory from '../components/ChatHistory';
import Markdown from '../components/Markdown';
import ThinkingTrace from '../components/ThinkingTrace';
import { useStream } from '../stream';
import { useChat, type Turn } from '../chat';
import { LINE, MONO } from '../theme';

const { Text } = Typography;
const { useBreakpoint } = Grid;

const HISTORY_WIDTH = 232;
const HISTORY_GUTTER = 16;
// Wider than the history list: every row here is a slider paired with a number
// box, and squeezing that pair is what clipped the controls when this panel was
// first docked.
const SETTINGS_WIDTH = 300;
const SETTINGS_GUTTER = 16;
/**
 * The preview is wider than the settings column and resizable, because unlike a
 * list of sliders its right width is a property of the content: a colour swatch
 * wants 300px and a dashboard wants everything going.
 */
const PREVIEW_DEFAULT = 460;
const PREVIEW_MIN = 280;
const PREVIEW_GUTTER = 16;
/** Space outside each panel's rule. Carried by the panel, not by a flex gap on
 *  the row, so a closed panel collapses to nothing instead of leaving a gap. */
const PANEL_MARGIN = 20;
const PANEL_TRANSITION = 'width 220ms cubic-bezier(0.4,0,0.2,1), opacity 160ms ease,'
  + ' padding 220ms cubic-bezier(0.4,0,0.2,1), margin 220ms cubic-bezier(0.4,0,0.2,1)';

const SUGGESTIONS = [
  '用三句話解釋 MoE 模型',
  '寫一個 Python 的 LRU cache，含測試',
  '這台機器適合跑多大的模型？',
];

/**
 * Seconds since the request went out, ticking.
 *
 * A fixed "thinking…" looks identical whether the model is composing a long
 * answer or the backend has stopped answering at all. A number that keeps
 * moving distinguishes the two without the reader having to ask.
 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.max(0, (now - since) / 1000);
  return (
    <Text style={{ fontSize: 11, opacity: 0.35, fontFamily: MONO }}>
      {seconds.toFixed(1)}s
    </Text>
  );
}

function TurnStats({ turn }: { turn: Turn }) {
  const t = turn.timings;
  if (!t && !turn.usage) return null;
  const bits: string[] = [];
  if (t) {
    bits.push(`${t.predicted_n} tok`);
    bits.push(`${t.predicted_per_second.toFixed(1)} t/s`);
    if (t.cache_n > 0) bits.push(`快取 ${t.cache_n}`);
  } else if (turn.usage) {
    bits.push(`${turn.usage.completion_tokens} tok`);
  }
  if (turn.ttft_ms !== undefined) bits.push(`首字 ${(turn.ttft_ms / 1000).toFixed(2)}s`);

  return (
    <Tooltip title="取自 llama-server 的內部計時，不含網路與排隊時間">
      <Text style={{ fontSize: 10.5, opacity: 0.35, fontFamily: MONO }}>{bits.join('  ')}</Text>
    </Tooltip>
  );
}

function ChatInner() {
  const { message: toast } = AntApp.useApp();
  const { models } = useStream();
  const {
    model, setModel, turns, draft, setDraft, images, setImages,
    params, setParams, streaming, streamStartedAt, conversationId, historyKey,
    send, stop, regenerate, openConversation, newConversation, error, clearError,
  } = useChat();

  const screens = useBreakpoint();
  // Below lg the conversation cannot afford a docked column: subtracting the
  // nav and a 232px panel from a narrow window leaves ~200px, which is less
  // than the composer's own controls need. It overlays instead.
  const roomForPanel = screens.lg ?? false;
  // Settings need a higher bar than history, because the two can be open at
  // once. At lg the pair would eat ~600px and leave the conversation under
  // 150px; xl is the first width where both fit and the reply still reads.
  const roomForSettings = screens.xl ?? false;

  // Non-null: ChatInner is always rendered inside the provider below.
  const preview = usePreview()!;

  const [atBottom, setAtBottom] = useState(true);
  // Both panels are remembered: whether they sit beside the conversation is a
  // lasting preference rather than a per-visit one. This was not true while
  // settings were a modal -- reopening one over the conversation on every visit
  // would have been an interruption rather than a layout.
  const [showSettings, setShowSettings] = useState(
    () => localStorage.getItem('chat.settings') === 'on',
  );
  const [showHistory, setShowHistory] = useState(
    () => localStorage.getItem('chat.history') === 'on',
  );
  const [previewWidth, setPreviewWidth] = useState(() => {
    const saved = Number(localStorage.getItem('chat.previewWidth'));
    return Number.isFinite(saved) && saved >= PREVIEW_MIN ? saved : PREVIEW_DEFAULT;
  });
  const scroller = useRef<HTMLDivElement>(null);

  // Pick a loaded model once the list arrives; a stopped one would make the
  // first message pay for a multi-GiB load nobody asked for.
  useEffect(() => {
    if (model && models.some((m) => m.id === model)) return;
    const next = models.find((m) => m.state === 'ready')?.id
      ?? models.find((m) => m.state === 'starting')?.id
      ?? models[0]?.id;
    if (next) setModel(next);
  }, [models, model, setModel]);

  useEffect(() => {
    if (error) { toast.error(error); clearError(); }
  }, [error, toast, clearError]);

  useEffect(() => {
    localStorage.setItem('chat.history', showHistory ? 'on' : 'off');
  }, [showHistory]);

  useEffect(() => {
    localStorage.setItem('chat.settings', showSettings ? 'on' : 'off');
  }, [showSettings]);

  useEffect(() => {
    localStorage.setItem('chat.previewWidth', String(previewWidth));
  }, [previewWidth]);

  // Settings and the preview both dock to the right edge, and both open at once
  // would leave the conversation narrower than the composer's own controls. The
  // newer request wins.
  useEffect(() => {
    if (preview.target) setShowSettings(false);
  }, [preview.target]);

  /**
   * Drag the panel's leading edge to resize.
   *
   * Pointer capture rather than window listeners: the pointer crosses the
   * iframe while dragging, and a frame from another origin swallows the events
   * that would otherwise reach a listener on window -- the drag would stick.
   */
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = previewWidth;

    const move = (e: PointerEvent) => {
      // Dragging left widens: the panel is on the right, so its leading edge
      // moving towards the start of the line grows it.
      const next = startWidth + (startX - e.clientX);
      setPreviewWidth(Math.max(PREVIEW_MIN, Math.min(next, window.innerWidth - 360)));
    };
    const stop = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }, [previewWidth]);

  const active = models.find((m) => m.id === model);

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

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('已複製');
    } catch {
      toast.warning('瀏覽器不允許複製（純 HTTP 下會被擋），請手動選取');
    }
  };

  const contextUsed = useMemo(() => {
    const usage = [...turns].reverse().find((t) => t.usage)?.usage;
    return usage ? usage.prompt_tokens + usage.completion_tokens : 0;
  }, [turns]);

  // Switching models mid-thread is supported, but a model without a vision
  // projector silently ignores the images already in the history rather than
  // erroring, so the mismatch has to be said out loud.
  const imagesInThread = turns.some((t) => t.images?.length);
  const visionLost = imagesInThread && active?.capabilities?.source === 'live'
    && !active.capabilities.vision;

  // The reply that produced the thread may not be the model selected now.
  const priorModels = useMemo(() => {
    const seen = turns.map((t) => t.model).filter((m): m is string => !!m && m !== model);
    return [...new Set(seen)];
  }, [turns, model]);

  const history = (
    <ChatHistory
      currentId={conversationId}
      onOpen={(id) => { void openConversation(id); if (!roomForPanel) setShowHistory(false); }}
      onNew={() => { newConversation(); if (!roomForPanel) setShowHistory(false); }}
      refreshKey={historyKey}
    />
  );

  const settings = (
    <ChatSettings params={params} onChange={setParams} model={active} contextUsed={contextUsed} />
  );

  return (
    <div style={{
      // No flex gap: the spacing between a panel and the conversation belongs to
      // the panel, so that a closed one takes no room at all.
      display: 'flex',
      // Fill the viewport below the sticky header and the page padding, so the
      // composer sits at the bottom instead of below the fold.
      height: 'calc(100vh - 56px - 48px)',
    }}>
      {roomForPanel && (
        // The outer width has to include the padding, because box-sizing is
        // border-box: setting it to HISTORY_WIDTH left a 216px content box for
        // a 232px child, and overflow:hidden silently clipped the right edge.
        // That clipping was the cut-off controls, not their size.
        <div style={{
          width: showHistory ? HISTORY_WIDTH + HISTORY_GUTTER : 0,
          flexShrink: 0, overflow: 'hidden',
          opacity: showHistory ? 1 : 0,
          borderInlineEnd: `1px solid ${showHistory ? LINE.faint : 'transparent'}`,
          paddingInlineEnd: showHistory ? HISTORY_GUTTER : 0,
          marginInlineEnd: showHistory ? PANEL_MARGIN : 0,
          transition: PANEL_TRANSITION,
        }}>
          <div style={{ width: HISTORY_WIDTH, height: '100%' }}>{history}</div>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {models.length === 0 && (
          <Alert type="info" showIcon style={{ marginBottom: 12 }}
                 message="尚未設定任何模型"
                 description="請先到「模型」頁新增，才能在這裡對話。" />
        )}

        {visionLost && (
          <Alert type="warning" showIcon closable style={{ marginBottom: 12 }}
                 message="目前的模型讀不到這段對話裡的圖片"
                 description="它沒有載入視覺投影檔，圖片會被略過而不會報錯。要讓它看圖，請換回有視覺能力的模型。" />
        )}

        {priorModels.length > 0 && (
          <Alert type="info" showIcon closable style={{ marginBottom: 12 }}
                 message={`這段對話混用了模型：${priorModels.join('、')}`}
                 description="接續是可行的——歷史只是文字。每則回覆上方標示的是實際產生它的模型。" />
        )}

        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <div
            ref={scroller}
            onScroll={onScroll}
            style={{ height: '100%', overflowY: 'auto', paddingRight: 12 }}
          >
            {turns.length === 0 ? (
              <div style={{ paddingTop: '18vh' }}>
                <Empty description="開始一段對話" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                <Space wrap size={8} style={{ justifyContent: 'center', width: '100%', marginTop: 16 }}>
                  {SUGGESTIONS.map((s) => (
                    <Button key={s} size="small" onClick={() => send(s)} disabled={!model}>
                      {s}
                    </Button>
                  ))}
                </Space>
              </div>
            ) : (
              turns.map((turn, index) => {
                const isUser = turn.role === 'user';
                const isLast = index === turns.length - 1;
                return (
                  <div
                    key={index}
                    className="turn-in"
                    style={{
                      // No bubbles: long code answers read as a document, and a
                      // tinted box around a 60-line snippet fights the content.
                      // Sides carry the speaker instead.
                      padding: '18px 0',
                      borderTop: index === 0 ? 'none' : `1px solid ${LINE.faint}`,
                      display: 'flex',
                      justifyContent: isUser ? 'flex-end' : 'flex-start',
                    }}
                  >
                    <div style={{
                      minWidth: 0,
                      // The reply runs full width because code and tables need
                      // it; the prompt is short and sits in a narrower column
                      // on the right, which is what makes the sides readable.
                      maxWidth: isUser ? '76%' : '100%',
                      width: isUser ? undefined : '100%',
                      // A hairline on the reader's side rather than a fill.
                      borderInlineEnd: isUser ? `2px solid ${LINE.soft}` : undefined,
                      paddingInlineEnd: isUser ? 14 : 0,
                    }}>
                    <Text style={{
                      fontSize: 10, letterSpacing: 1.4, fontFamily: MONO,
                      opacity: isUser ? 0.5 : 0.4, display: 'block', marginBottom: 8,
                      textAlign: isUser ? 'right' : 'left',
                    }}>
                      {isUser
                        ? '你'
                        : (models.find((m) => m.id === turn.model)?.name
                           ?? turn.model
                           ?? active?.name ?? active?.id ?? 'ASSISTANT').toUpperCase()}
                    </Text>

                    {turn.images?.length ? (
                      <Space wrap size={6} style={{
                        marginBottom: 10,
                        justifyContent: isUser ? 'flex-end' : 'flex-start',
                        width: '100%',
                      }}>
                        {turn.images.map((src, i) => (
                          <Image key={i} src={src} width={128} style={{ borderRadius: 4 }} />
                        ))}
                      </Space>
                    ) : null}

                    {turn.reasoning ? (
                      <ThinkingTrace
                        reasoning={turn.reasoning}
                        live={isLast && streaming && !turn.content}
                        ms={turn.thinking_ms}
                      />
                    ) : null}

                    {isUser ? (
                      <Text style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{turn.content}</Text>
                    ) : (
                      <Markdown>{turn.content}</Markdown>
                    )}

                    {isLast && streaming && !turn.content && !turn.reasoning && (
                      <Space size={8}>
                        <Text style={{ fontSize: 12, opacity: 0.4 }}>思考中…</Text>
                        <Elapsed since={streamStartedAt} />
                      </Space>
                    )}

                    {turn.finish_reason === 'length' && (
                      <Tooltip title={`回覆在 ${params.max_tokens} tokens 處被切斷。調高右側的 max tokens 後重新生成即可取得完整內容。`}>
                        <Tag color="warning" style={{ marginTop: 10 }}>
                          已達 max tokens 上限，內容被截斷
                        </Tag>
                      </Tooltip>
                    )}

                    <Space size={2} wrap style={{
                      marginTop: 10, width: '100%',
                      justifyContent: isUser ? 'flex-end' : 'flex-start',
                    }}>
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
              })
            )}
          </div>

          {!atBottom && (
            <Button
              shape="circle" icon={<DownOutlined />}
              style={{ position: 'absolute', right: 24, bottom: 12 }}
              onClick={() => {
                setAtBottom(true);
                if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
              }}
            />
          )}
        </div>

        <div style={{ paddingTop: 12 }}>
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => send()}
            onStop={stop}
            streaming={streaming}
            disabled={!model}
            capabilities={active?.capabilities}
            images={images}
            onImagesChange={setImages}
            models={models}
            model={model}
            onModelChange={setModel}
            onClear={newConversation}
            canClear={turns.length > 0 && !streaming}
            onToggleSettings={() => setShowSettings((v) => !v)}
            settingsOpen={showSettings}
            onToggleHistory={() => setShowHistory((v) => !v)}
            historyOpen={showHistory}
          />
        </div>
      </div>

      {roomForSettings && (
        <div style={{
          width: showSettings ? SETTINGS_WIDTH + SETTINGS_GUTTER : 0,
          flexShrink: 0, overflow: 'hidden',
          opacity: showSettings ? 1 : 0,
          borderInlineStart: `1px solid ${showSettings ? LINE.faint : 'transparent'}`,
          paddingInlineStart: showSettings ? SETTINGS_GUTTER : 0,
          marginInlineStart: showSettings ? PANEL_MARGIN : 0,
          transition: PANEL_TRANSITION,
        }}>
          <div style={{
            width: SETTINGS_WIDTH, height: '100%',
            display: 'flex', flexDirection: 'column',
          }}>
            <Space size={8} style={{ marginBottom: 10, paddingInlineStart: 2 }}>
              <SlidersOutlined style={{ opacity: 0.4, fontSize: 12 }} />
              <Text style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1, opacity: 0.45 }}>
                PARAMETERS
              </Text>
            </Space>
            {/* The rows scroll, the heading does not: the panel is taller than
                the viewport on a short window. */}
            <div style={{ flex: 1, overflowY: 'auto', paddingInlineEnd: 8 }}>
              {settings}
            </div>
          </div>
        </div>
      )}

      {roomForPanel && preview.target && (
        <div style={{
          width: previewWidth + PREVIEW_GUTTER,
          flexShrink: 0, overflow: 'hidden',
          paddingInlineStart: PREVIEW_GUTTER,
          marginInlineStart: PANEL_MARGIN,
          display: 'flex',
        }}>
          {/* The grab strip sits outside the panel's own border so the cursor
              changes over empty space rather than over the preview itself. */}
          <div
            onPointerDown={startResize}
            style={{
              width: 5, marginInlineStart: -PREVIEW_GUTTER, marginInlineEnd: PREVIEW_GUTTER - 5,
              cursor: 'col-resize', flexShrink: 0, alignSelf: 'stretch',
              borderInlineStart: `1px solid ${LINE.faint}`,
              touchAction: 'none',
            }}
          />
          <div style={{ width: previewWidth, height: '100%' }}>
            <PreviewPanel
              target={preview.target}
              onRerun={preview.rerun}
              onClose={preview.close}
            />
          </div>
        </div>
      )}

      {!roomForPanel && (
        <Drawer
          title={`${preview.target?.language.toUpperCase() ?? ''} 預覽`}
          placement="right"
          width="92%"
          open={preview.target !== null}
          onClose={preview.close}
          styles={{ body: { padding: 12 } }}
          extra={
            <Button size="small" icon={<ReloadOutlined />} onClick={preview.rerun}>
              重新執行
            </Button>
          }
        >
          {preview.target && (
            <PreviewPanel
              target={preview.target}
              onRerun={preview.rerun}
              onClose={preview.close}
              showClose={false}
            />
          )}
        </Drawer>
      )}

      {!roomForPanel && (
        <Drawer
          title="對話紀錄"
          placement="left"
          width={280}
          open={showHistory}
          onClose={() => setShowHistory(false)}
          styles={{ body: { padding: 12 } }}
        >
          {history}
        </Drawer>
      )}

      {!roomForSettings && (
        // Too narrow to dock a 300px column beside the conversation, so the
        // same panel arrives from the same edge instead.
        <Drawer
          title={
            <Space size={8}>
              <SlidersOutlined style={{ opacity: 0.5 }} />
              <span style={{ fontFamily: MONO, fontSize: 12, letterSpacing: 1 }}>PARAMETERS</span>
            </Space>
          }
          placement="right"
          width={340}
          open={showSettings}
          onClose={() => setShowSettings(false)}
          styles={{ body: { padding: 12 } }}
        >
          {settings}
        </Drawer>
      )}
    </div>
  );
}

/**
 * The preview panel is opened from a button inside a reply and rendered at the
 * page edge, so the state joining them has to sit above both.
 */
export default function Chat() {
  return (
    <PreviewProvider>
      <ChatInner />
    </PreviewProvider>
  );
}
