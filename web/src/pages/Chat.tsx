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
import { NoPreview, PreviewProvider, usePreview } from '../components/preview';
import ChatHistory from '../components/ChatHistory';
import Markdown, { lastVisualBlock, splitCode } from '../components/Markdown';
import Trace from '../components/Trace';
import { useStream } from '../stream';
import { foldExchanges, useChat, type Turn } from '../chat';
import { LINE, MONO } from '../theme';
import { useNarrow } from '../components/Sidebar';
import { benchActive, pauseMessage, useBenchStatus } from '../benchState';

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

/** How much prose it takes to believe the answer has started, in a run that
 *  used the sandbox. A line written on the way to a tool call is a hand-off --
 *  "let me work this out" -- and stops there; an answer keeps going. */
const ANSWER_CHARS = 120;
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
  // Measured here when the server gives counts and no timings (vLLM): the
  // tokens over the time from the first one to the last, which includes the
  // network and is a shade lower than the server's own figure would be.
  const measured = !t && turn.usage && turn.decode_ms && turn.decode_ms > 0;
  if (t) {
    bits.push(`${t.predicted_n} tok`);
    bits.push(`${t.predicted_per_second.toFixed(1)} t/s`);
    if (t.cache_n > 0) bits.push(`快取 ${t.cache_n}`);
  } else if (turn.usage) {
    bits.push(`${turn.usage.completion_tokens} tok`);
    if (measured) {
      bits.push(`${(turn.usage.completion_tokens / (turn.decode_ms! / 1000)).toFixed(1)} t/s`);
    }
    if (turn.usage.prompt_tokens) bits.push(`輸入 ${turn.usage.prompt_tokens}`);
  }
  if (turn.ttft_ms !== undefined) bits.push(`首字 ${(turn.ttft_ms / 1000).toFixed(2)}s`);

  return (
    <Tooltip title={t
      ? '取自 llama-server 的內部計時，不含網路與排隊時間'
      : 'token 數由伺服器回報；速度是這裡從第一個字到最後一個字量的，含思考，也含網路'}>
      <Text style={{ fontSize: 10.5, opacity: 0.35, fontFamily: MONO }}>{bits.join('  ')}</Text>
    </Tooltip>
  );
}

function ChatInner() {
  const { message: toast } = AntApp.useApp();
  const { models } = useStream();
  // While a benchmark holds /v1 every request from here would come back 503;
  // the input says so instead of letting a message be typed and refused.
  const { status: bench } = useBenchStatus();
  const paused = benchActive(bench);
  const {
    model, setModel, seedParams, turns, draft, setDraft, images, setImages,
    params, setParams, streaming, agent, setAgent, step,
    streamStartedAt, conversationId, historyKey,
    send, stop, regenerate, openConversation, newConversation, error, clearError,
  } = useChat();

  // Folded once here rather than pattern-matched inside the renderer.
  const exchanges = useMemo(() => foldExchanges(turns), [turns]);


  const screens = useBreakpoint();
  // Below lg the conversation cannot afford a docked column: subtracting the
  // nav and a 232px panel from a narrow window leaves ~200px, which is less
  // than the composer's own controls need. It overlays instead.
  const roomForPanel = screens.lg ?? false;
  const narrow = useNarrow();
  // Settings need a higher bar than history, because the two can be open at
  // once. At lg the pair would eat ~600px and leave the conversation under
  // 150px; xl is the first width where both fit and the reply still reads.
  const roomForSettings = screens.xl ?? false;

  // Non-null: ChatInner is always rendered inside the provider below.
  const preview = usePreview()!;

  /**
   * Open the preview by itself when a reply finishes with something to show.
   *
   * Waiting for the run button meant the common case -- ask for a page, get a
   * page, look at it -- took a click that only ever had one answer. It fires
   * once per reply, keyed on the answer's identity, so re-rendering or
   * scrolling does not reopen a panel the reader closed.
   *
   * Only for the visual languages. Python's output is text and belongs in the
   * conversation where it was asked for; opening a panel to print a number
   * would move the answer away from the question.
   */
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (streaming || !preview) return;
    const last = exchanges[exchanges.length - 1]?.answer;
    if (!last?.content) return;

    const key = `${exchanges.length}:${last.content.length}`;
    if (opened.current === key) return;
    opened.current = key;

    const block = lastVisualBlock(last.content);
    if (block) preview.open(block.source, block.language);
  }, [exchanges, streaming, preview]);

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

  // The panel follows the model. Its sampling flags live in llama-swap's config
  // and are only server-side defaults, which this console overrides on every
  // request -- so without this the numbers written there never take effect for
  // the client that matters most, and the two quietly disagree.
  useEffect(() => {
    seedParams(models.find((m) => m.id === model));
  }, [models, model, seedParams]);

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

  // A preview belongs to the reply it was opened from, so it cannot outlive the
  // conversation containing that reply -- leaving it up would show one thread's
  // code beside another thread's messages, with a re-run button that reloads
  // something no longer on screen.
  useEffect(() => {
    preview.close();
  }, [conversationId, preview.close]);

  /**
   * Drag the panel's leading edge to resize.
   *
   * Pointer capture rather than window listeners: the pointer crosses the
   * iframe while dragging, and a frame from another origin swallows the events
   * that would otherwise reach a listener on window -- the drag would stick.
   */
  // Set while the edge is being dragged, so the panel's width transition can
  // stand down. An eased width fights the cursor and lags behind it.
  const resizing = useRef(false);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizing.current = true;
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
      resizing.current = false;
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
    <ChatSettings
      params={params}
      onChange={setParams}
      model={active}
      onReset={() => seedParams(active, true)}
      contextUsed={contextUsed}
    />
  );

  return (
    <div style={{
      // No flex gap: the spacing between a panel and the conversation belongs to
      // the panel, so that a closed one takes no room at all.
      display: 'flex',
      // Fill the viewport below the sticky header and the page padding, so the
      // composer sits at the bottom instead of below the fold.
      height: narrow ? 'calc(100vh - 56px - 24px)' : 'calc(100vh - 56px - 48px)',
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
                    <Button key={s} size="small" onClick={() => send(s)} disabled={!model || paused}
                            style={{ maxWidth: '100%', height: 'auto', whiteSpace: 'normal' }}>
                      {s}
                    </Button>
                  ))}
                </Space>
              </div>
            ) : (
              exchanges.map((exchange, index) => {
                const isLast = index === exchanges.length - 1;
                const answer = exchange.answer;
                // The trace is live while this exchange is being produced, and
                // folds once the answer starts.
                //
                // Knowing when that is takes a guess in a run that used the
                // sandbox: a model writes a line, runs something, writes
                // another line, and which of those was the answer is only known
                // from a finish_reason that arrives after the text does. Folding
                // on the first word shut the working on every hand-off line and
                // reopened it on the next call; waiting for the stream to stop
                // left it propped open over an answer already being read.
                //
                // So length decides, and a run that executed nothing needs no
                // guess at all -- it folds on the first word, as it always did.
                const ran = exchange.steps.some((step) => step.kind === 'code');
                const written = answer?.content?.length ?? 0;
                const tracing = isLast && streaming && written <= (ran ? ANSWER_CHARS : 0);

                // The byline, resolved once: who answered, which build it was,
                // and what the reply cost in wall time.
                const info = models.find((m) => m.id === answer?.model);
                const modelId = answer?.model ?? active?.id;
                const who = info?.name ?? modelId ?? active?.name ?? '助理';
                // The id only when it says something the name does not.
                const build = modelId && modelId !== who ? modelId : null;
                const spent = (answer?.timings?.predicted_ms ?? 0)
                  + (answer?.timings?.prompt_ms ?? 0);

                return (
                  <div key={index} style={{
                    // Space between exchanges, not a rule. A hairline drawn
                    // across every turn filed the thread into records; a
                    // conversation is read as one column, and the gap plus the
                    // side a turn sits on already says who is speaking.
                    paddingTop: index === 0 ? 4 : 26,
                  }}>
                    {exchange.user && (
                      <div className="turn-in turn-row" style={{
                        display: 'flex', justifyContent: 'flex-end',
                        alignItems: 'flex-start', gap: 4,
                      }}>
                        <Tooltip title="複製">
                          <Button className="turn-act" type="text" size="small"
                                  icon={<CopyOutlined />}
                                  onClick={() => copy(exchange.user!.content)} />
                        </Tooltip>
                        <div className="turn-said" style={{
                          minWidth: 0, maxWidth: '78%',
                          // The one thing in the thread that is drawn rather
                          // than laid out. A reply is long, quoted, full of
                          // code and tables; a question is a sentence. Giving
                          // the fill to the short half is what makes the pair
                          // read as a question and its answer, and it costs the
                          // long half nothing.
                          background: 'rgba(255,255,255,0.055)',
                          borderRadius: 14, padding: '9px 14px',
                        }}>
                          {exchange.user.images?.length ? (
                            <Space wrap size={6} style={{
                              marginBottom: 8, justifyContent: 'flex-end', width: '100%',
                            }}>
                              {exchange.user.images.map((src, i) => (
                                <Image key={i} src={src} width={128} style={{ borderRadius: 6 }} />
                              ))}
                            </Space>
                          ) : null}
                          {/* What the composer drew, drawn again. A fenced
                              block was a block while it was being typed; it
                              should not turn back into three backticks the
                              moment it is sent. Prose stays prose -- the
                              composer never rendered a heading or a bold run,
                              so neither does this. */}
                          {splitCode(exchange.user.content).map((part, i) => (
                            part.code ? (
                              <NoPreview key={i}>
                                <Markdown>{part.text}</Markdown>
                              </NoPreview>
                            ) : (
                              <Text key={i} style={{
                                whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.55,
                                display: 'block',
                              }}>
                                {part.text}
                              </Text>
                            )
                          ))}
                        </div>
                      </div>
                    )}

                    {(exchange.steps.length > 0 || answer) && (
                      <div className="turn-in turn-row" style={{
                        // No bubble on this side: long code answers read as a
                        // document, and a tinted box around a 60-line snippet
                        // fights the content.
                        marginTop: exchange.user ? 12 : 0,
                        // Measured, not full width. This ran to whatever the
                        // window gave it on the reasoning that code and tables
                        // need the room; on a wide screen that put prose on
                        // 160-character lines, about twice what is comfortable.
                        // 820px is roughly 90 characters here. Code and tables
                        // keep their own horizontal scroll inside it rather
                        // than setting the width of everything around them.
                        maxWidth: 820,
                      }}>
                        {/* One line, three weights: who answered, which build,
                            what it cost. The old label was a mono all-caps rule
                            of its own, which read as a heading over a document
                            rather than as the byline of a turn. */}
                        <div style={{
                          display: 'flex', alignItems: 'baseline', gap: 7,
                          marginBottom: 9, minWidth: 0,
                        }}>
                          <Text style={{ fontSize: 12, fontWeight: 500 }}>{who}</Text>
                          {build && (
                            <Tooltip title={build}>
                              <Text style={{
                                fontSize: 11, fontFamily: MONO, opacity: 0.38,
                                maxWidth: 240, overflow: 'hidden',
                                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>{build}</Text>
                            </Tooltip>
                          )}
                          {spent > 0 && (
                            <Text style={{ fontSize: 11, opacity: 0.5 }}>
                              費時 {(spent / 1000).toFixed(spent < 10000 ? 1 : 0)}s
                            </Text>
                          )}
                        </div>

                        <Trace steps={exchange.steps} live={tracing} />

                        {answer?.content ? <Markdown>{answer.content}</Markdown> : null}

                        {/* The figures the run drew, with the answer rather
                            than inside the working. Asked for a chart, the
                            chart is the reply; it should not need a code row
                            opened to be seen. */}
                        {exchange.figures.map((src, i) => (
                          <Image
                            key={i}
                            src={src}
                            style={{
                              marginTop: 10, borderRadius: 6, background: '#fff',
                              maxWidth: '100%', width: 560,
                            }}
                          />
                        ))}

                        {tracing && !exchange.steps.length && (
                          <Space size={8}>
                            <Text style={{ fontSize: 12, opacity: 0.4 }}>
                              {step > 1 ? `第 ${step} 步・思考中…` : '思考中…'}
                            </Text>
                            <Elapsed since={streamStartedAt} />
                          </Space>
                        )}

                        {answer?.finish_reason === 'length' && (
                          <Tooltip title={`回覆在 ${params.max_tokens} tokens 處被切斷。調高右側的 max tokens 後重新生成即可取得完整內容。`}>
                            <Tag color="warning" style={{ marginTop: 10 }}>
                              已達 max tokens 上限，內容被截斷
                            </Tag>
                          </Tooltip>
                        )}

                        <Space size={2} wrap style={{ marginTop: 8, width: '100%' }}>
                          <span className="turn-act">
                            <Tooltip title="複製">
                              <Button type="text" size="small" icon={<CopyOutlined />}
                                      onClick={() => copy(answer?.content ?? '')} />
                            </Tooltip>
                            {isLast && !streaming && (
                              <Tooltip title="重新生成">
                                <Button type="text" size="small" icon={<RedoOutlined />}
                                        onClick={regenerate} />
                              </Tooltip>
                            )}
                          </span>
                          {answer && <TurnStats turn={answer} />}
                        </Space>
                      </div>
                    )}
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
            disabled={!model || paused}
            placeholder={paused ? pauseMessage(bench) : undefined}
            capabilities={active?.capabilities}
            images={images}
            onImagesChange={setImages}
            models={models}
            model={model}
            onModelChange={setModel}
            onClear={newConversation}
            canClear={turns.length > 0 && !streaming}
            agent={agent}
            onAgentChange={setAgent}
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

      {/* Width, not display. The panel arrives by growing from nothing and
          leaves by shrinking back, so the conversation beside it moves rather
          than jumping -- which matters more now that it can open by itself and
          the reader did not ask for the layout to change. `overflow: hidden`
          holds the contents at full size while the box around them animates,
          so nothing reflows on the way. */}
      {roomForPanel && (
        <div style={{
          width: preview.target ? previewWidth + PREVIEW_GUTTER : 0,
          opacity: preview.target ? 1 : 0,
          flexShrink: 0, overflow: 'hidden',
          paddingInlineStart: preview.target ? PREVIEW_GUTTER : 0,
          marginInlineStart: preview.target ? PANEL_MARGIN : 0,
          display: 'flex',
          transition: resizing.current
            // Not while a pointer is dragging the edge: an eased width fights
            // the cursor and the panel lags behind where it is being put.
            ? 'none'
            : 'width 320ms cubic-bezier(0.23,1,0.32,1),'
              + ' opacity 220ms ease,'
              + ' padding-inline-start 320ms cubic-bezier(0.23,1,0.32,1),'
              + ' margin-inline-start 320ms cubic-bezier(0.23,1,0.32,1)',
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
            {preview.target && (
              <PreviewPanel
                target={preview.target}
                onRerun={preview.rerun}
                onClose={preview.close}
              />
            )}
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
