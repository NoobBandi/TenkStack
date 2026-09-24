import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  chatStream, DEFAULT_PARAMS, fetchChat, patchChat, saveChat, searchAvailable,
  webRead, webSearch,
  type ModelInfo,
  type ChatMessage, type ChatParams, type Timings, type ToolCall, type Usage,
} from './api';
import { usePythonRuntime, type RunResult } from './components/pythonRuntime';
import type { Step } from './components/Trace';
import {
  describeCall, describePage, describeResult, describeSearch, MAX_STEPS, parseCode,
  SANDBOX_TOOL, SEARCH_TOOLS,
} from './sandboxTool';

/**
 * The conversation, held above the router.
 *
 * A page component unmounts when the user navigates, taking its state and its
 * in-flight fetch with it — leaving the chat page mid-answer used to lose the
 * answer. Owning the session here means switching to the dashboard and back
 * finds the reply still streaming.
 */

export interface Turn extends ChatMessage {
  /** What a `tool` turn actually did, kept beside the text the model reads so
   *  the interface can show the code and its output rather than the prose
   *  summary of them. */
  run?: {
    /** What the tool was asked for: the code, the query, the URL. */
    code: string;
    /** Which tool, for the row's label. */
    tool: string;
    /** Present for Python, which returns structured output. */
    result?: RunResult;
    /** Present for the tools that return text, so the row can show what came
     *  back without the trace having to know each tool's shape. */
    output?: string;
    /** A search's results, kept structured rather than only as the prose the
     *  model reads. The trace lists them as links, and a link is a thing to
     *  click rather than a string in a paragraph. */
    sources?: { title: string; url: string }[];
  };
  usage?: Usage;
  timings?: Timings;
  finish_reason?: string;
  /** Which model produced this reply; a thread can be continued by another. */
  model?: string;
  ttft_ms?: number;
  /** Wall time spent inside the reasoning block, first thought to first word.
   *  A collapsed trace says nothing about what it cost; this does. */
  thinking_ms?: number;
  /** From the first token to the last, measured here. What a speed is
   *  worked out from when the server reports tokens but no timings --
   *  vLLM sends usage and nothing else. */
  decode_ms?: number;
}

/**
 * Fold one exchange's turns into the trace and the answer.
 *
 * The wire format is a list -- an assistant turn carrying tool calls, a tool
 * turn with the result, another assistant turn -- because that is what the
 * server has to be sent. It is not what anyone wants to read. On screen an
 * exchange is one reply with a record of how it was arrived at, so the list is
 * folded back into exactly that here, once, rather than being pattern-matched
 * inside the renderer.
 *
 * The last assistant turn holds the answer; everything before it is trace.
 */
export interface Exchange {
  user: Turn | null;
  steps: Step[];
  answer: Turn | null;
  /** Every figure the run drew, lifted out of the steps that produced them.
   *  A plot is the answer to the question that asked for one, not evidence of
   *  how the answer was reached -- leaving it inside a collapsed code row means
   *  the thing that was asked for is the one thing not shown. */
  figures: string[];
}

export function foldExchanges(turns: Turn[]): Exchange[] {
  const out: Exchange[] = [];
  let current: Exchange | null = null;

  for (const turn of turns) {
    if (turn.role === 'user') {
      current = { user: turn, steps: [], answer: null, figures: [] };
      out.push(current);
      continue;
    }
    if (!current) {
      current = { user: null, steps: [], answer: null, figures: [] };
      out.push(current);
    }

    if (turn.role === 'tool') {
      current.steps.push({ kind: 'code', text: turn.run?.code ?? '', turn });
      current.figures.push(...(turn.run?.result?.images ?? []));
      continue;
    }

    // An assistant turn contributes its thinking to the trace either way; it
    // becomes the answer only if it stopped to answer rather than to ask for
    // something to be run.
    if (turn.reasoning) {
      current.steps.push({ kind: 'reasoning', text: turn.reasoning, ms: turn.thinking_ms });
    }
    if (turn.finish_reason !== 'tool_calls') current.answer = turn;
  }
  return out;
}

/**
 * Markdown is re-parsed per render and the cost grows with the reply (10.7 ms
 * at 6 KiB) while tokens arrive every ~11 ms. Twelve commits a second still
 * reads as continuous text and keeps the main thread free.
 */
const FLUSH_INTERVAL_MS = 80;

interface ChatState {
  model?: string;
  setModel: (id: string) => void;
  /** Load a model's configured sampling into the panel. Called when the model
   *  changes, and by the panel's reset. */
  seedParams: (model: ModelInfo | undefined, force?: boolean) => void;
  turns: Turn[];
  draft: string;
  setDraft: (v: string) => void;
  images: string[];
  setImages: (v: string[]) => void;
  params: ChatParams;
  setParams: (p: ChatParams) => void;
  streaming: boolean;
  /** Whether the model may call the sandbox. Off by default: it changes what
   *  an answer costs and how long it takes, which is not something to switch on
   *  for somebody without their asking. */
  agent: boolean;
  setAgent: (on: boolean) => void;
  /** Which step of an agent run is in flight, 0 when none is. */
  step: number;
  /** performance.now() when the current request went out, for an elapsed
   *  counter: a static "thinking…" cannot distinguish slow from stuck. */
  streamStartedAt: number;
  conversationId: number | null;
  historyKey: number;
  send: (text?: string) => void;
  stop: () => void;
  regenerate: () => void;
  openConversation: (id: number) => Promise<void>;
  newConversation: () => void;
  error: string | null;
  clearError: () => void;
}

const ChatContext = createContext<ChatState | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [model, setModel] = useState<string>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [params, setParams] = useState<ChatParams>(DEFAULT_PARAMS);
  /**
   * Which model the panel was last seeded for.
   *
   * Seeding has to happen when the model changes and not otherwise, or two
   * things break: an edit made after picking a model would be undone on the
   * next render, and opening a saved conversation would lose the settings it
   * was held under. Recording the model alongside the values is what separates
   * "the model changed" from "something else did".
   */
  const seededFor = useRef<string | undefined>(undefined);
  const [streaming, setStreaming] = useState(false);
  // Off by default. Offering the sandbox changes what an answer costs and how
  // long it takes, which is not something to switch on for somebody without
  // their asking.
  const [agent, setAgent] = useState(false);
  const [step, setStep] = useState(0);
  const sandbox = usePythonRuntime();
  // Probed once. SearXNG is a container that may not be running, and the
  // answer decides whether the search tools are offered at all.
  const [searchable, setSearchable] = useState(false);
  useEffect(() => {
    searchAvailable().then((d) => setSearchable(d.available)).catch(() => undefined);
  }, []);
  const [streamStartedAt, setStreamStartedAt] = useState(0);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);
  // The id is needed inside async work that started before setState settled.
  const idRef = useRef<number | null>(null);
  idRef.current = conversationId;

  const persist = useCallback(async (list: Turn[], activeModel: string) => {
    if (!list.length) return null;
    try {
      const { id } = await saveChat({
        id: idRef.current, model: activeModel, params, messages: list,
      });
      idRef.current = id;
      setConversationId(id);
      setHistoryKey((k) => k + 1);
      return id;
    } catch {
      // A failed save must not disturb a conversation that is otherwise fine.
      return null;
    }
  }, [params]);

  /**
   * Ask the model to name the thread.
   *
   * Runs after the first exchange only, and against the same model that is
   * already loaded, so it costs one short generation rather than a model swap.
   * Failure is silent: the fallback title taken from the first message is
   * already serviceable.
   */
  const generateTitle = useCallback(async (
    id: number, first: Turn, reply: Turn, activeModel: string,
  ) => {
    try {
      let title = '';
      for await (const delta of chatStream({
        model: activeModel,
        messages: [{
          role: 'user',
          content:
            '為以下對話取一個標題，10 個字以內，只輸出標題本身，不要引號或標點結尾。\n\n'
            + `問：${first.content.slice(0, 400)}\n`
            + `答：${reply.content.slice(0, 400)}`,
        }],
        params: {
          ...DEFAULT_PARAMS,
          max_tokens: 64,
          temperature: 0.3,
          thinking: false,
          // Thinking would spend the whole budget before reaching the title.
          reasoning_budget_tokens: 0,
        },
      })) {
        if (delta.content) title += delta.content;
      }
      title = title.trim().replace(/^["'「『]|["'」』。.]$/g, '').slice(0, 40);
      if (title) {
        await patchChat(id, { title });
        setHistoryKey((k) => k + 1);
      }
    } catch {
      // Keep the first-message fallback.
    }
  }, []);

  /**
   * One completion, streamed into the turn at the end of the list.
   *
   * Split out of `run` because an agent run does this several times: the model
   * answers, asks for something to be executed, reads the result, and answers
   * again. Everything that was once "the reply" is now "this step's reply".
   */
  const streamOnce = useCallback(async (
    messages: Turn[], activeModel: string, controller: AbortController,
    withTools: boolean,
  ): Promise<Turn> => {
    const startedAt = performance.now();
    setStreamStartedAt(startedAt);
    let ttft: number | undefined;
    // The reasoning block runs from its first token to the first word of the
    // answer, so it can only be closed out when the answer starts.
    let reasoningAt: number | undefined;
    let thinkingMs: number | undefined;
    let decodeMs: number | undefined;

    // Deltas accumulate outside React so no token is dropped even though most
    // of them never trigger a render.
    const pending: Partial<Turn> = {};
    let content = '';
    let reasoning = '';
    let calls: ToolCall[] | undefined;
    let lastFlush = 0;

    const flush = () => {
      lastFlush = performance.now();
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          ...next[next.length - 1], ...pending,
          content, reasoning, tool_calls: calls, ttft_ms: ttft,
          thinking_ms: thinkingMs, decode_ms: decodeMs, model: activeModel,
        };
        return next;
      });
    };

    for await (const delta of chatStream({
      model: activeModel,
      messages,
      params,
      signal: controller.signal,
      // Search only when the service answered. A tool that is offered and
      // then always fails is worse than one never mentioned -- the model
      // spends a step discovering it and often a second one retrying.
      ...(withTools
        ? { tools: [SANDBOX_TOOL, ...(searchable ? SEARCH_TOOLS : [])] }
        : {}),
    })) {
      if ((delta.content || delta.reasoning) && ttft === undefined) {
        ttft = performance.now() - startedAt;
        // Show the first token at once; the moment the user is watching for
        // should not wait for the next tick.
        lastFlush = 0;
      }
      if (delta.reasoning && reasoningAt === undefined) {
        reasoningAt = performance.now();
      }
      if (delta.content && reasoningAt !== undefined && thinkingMs === undefined) {
        thinkingMs = performance.now() - reasoningAt;
      }
      if (delta.content) content += delta.content;
      if (delta.reasoning) reasoning += delta.reasoning;
      if (delta.tool_calls) calls = delta.tool_calls;
      if (delta.usage) pending.usage = delta.usage;
      if (delta.timings) pending.timings = delta.timings;
      if (delta.finish_reason) pending.finish_reason = delta.finish_reason;
      if (performance.now() - lastFlush >= FLUSH_INTERVAL_MS) flush();
    }
    if (ttft !== undefined) decodeMs = performance.now() - startedAt - ttft;
    flush();

    // A reply that was all reasoning and no answer still spent the time.
    if (thinkingMs === undefined && reasoningAt !== undefined) {
      thinkingMs = performance.now() - reasoningAt;
    }
    return {
      role: 'assistant', content, reasoning, tool_calls: calls, ...pending,
      ttft_ms: ttft, thinking_ms: thinkingMs, decode_ms: decodeMs, model: activeModel,
    };
  }, [params, searchable]);

  /**
   * A turn, which may take several completions.
   *
   * The loop is the whole of the agent: stream, and if the model stopped to ask
   * for something rather than to answer, run it, hand back what happened, and
   * stream again. It ends when the model answers, when the step budget runs
   * out, or when the user aborts.
   *
   * The messages sent back are the OpenAI shape exactly -- an assistant turn
   * carrying `tool_calls`, then one `tool` turn per call -- so persistence,
   * regeneration and the next request all take the list as it stands with no
   * translation step to get wrong.
   */
  const run = useCallback(async (history: Turn[]) => {
    if (!model) return;
    const activeModel = model;
    const useTools = agent;

    // Save before generating: a question asked is worth keeping even if the
    // answer never arrives, and the history list should show the thread the
    // moment it starts rather than when it finishes.
    const isFirstExchange = history.filter((t) => t.role === 'user').length === 1;
    void persist(history, activeModel);

    setTurns([...history, { role: 'assistant', content: '', reasoning: '', model: activeModel }]);
    setStreaming(true);
    setStep(useTools ? 1 : 0);
    setError(null);

    const controller = new AbortController();
    abort.current = controller;

    let conversation = [...history];
    let last: Turn | null = null;

    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        setStep(useTools ? step + 1 : 0);
        const reply = await streamOnce(conversation, activeModel, controller, useTools);
        conversation = [...conversation, reply];
        last = reply;

        const calls = reply.tool_calls ?? [];
        if (reply.finish_reason !== 'tool_calls' || !calls.length) break;

        // Said out loud rather than stopping quietly. A run that used its whole
        // budget and never answered looks identical to one that finished, and
        // the reader is the only one who can decide whether to ask again.
        //
        // The calls of this last round are answered rather than executed.
        // Nothing would read the results -- the loop ends here -- so running
        // them costs up to a minute each and buys nothing. They still get
        // replies: an assistant message whose tool_calls were left unanswered
        // is not a conversation that can be continued, and this one is about to
        // be saved and asked a second question.
        if (step === MAX_STEPS - 1) {
          setError(`已用完 ${MAX_STEPS} 個步驟仍未得到答案，已停下。`);
          conversation = [...conversation, ...calls.map((call) => {
            const { heading, shown } = describeCall(call);
            const said = `已達 ${MAX_STEPS} 個步驟的上限，這個呼叫沒有執行。`;
            return {
              role: 'tool' as const,
              tool_call_id: call.id,
              content: said,
              run: { code: shown, tool: heading, output: said },
            };
          })];
          setTurns([...conversation]);
          break;
        }

        for (const call of calls) {
          if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
          const name = call.function.name;

          // Named before it is done, because a step that is running is the one
          // worth being able to see.
          const { heading, shown } = describeCall(call);

          setTurns([...conversation, {
            role: 'tool', tool_call_id: call.id, content: '',
            run: { code: shown, tool: heading },
          }]);

          let content: string;
          let result: RunResult | undefined;
          let sources: { title: string; url: string }[] | undefined;

          if (name === 'web_search' || name === 'read_page') {
            // These run on the backend, not in the sandbox: a frame with no
            // origin cannot reach a search engine, and a proxy that let it
            // would let any page reach one.
            try {
              const args = JSON.parse(call.function.arguments);
              if (name === 'web_search') {
                const found = await webSearch(String(args.query ?? ''));
                content = describeSearch(found);
                sources = found.results.map((r) => ({ title: r.title, url: r.url }));
              } else {
                const page = await webRead(String(args.url ?? ''), String(args.query ?? ''));
                content = describePage(page);
                sources = [{ title: page.title || page.url, url: page.url }];
              }
            } catch (err) {
              // A failed search is a fact the model can act on -- try other
              // words, or answer without it -- so it goes back as a result
              // rather than ending the turn.
              content = `這個工具失敗了：${(err as Error).message}`;
            }
          } else {
            const parsed = parseCode(call.function.arguments);
            result = 'error' in parsed
              ? { stdout: '', stderr: '', value: null, images: [],
                  error: parsed.error,
                  elapsed_ms: 0, timed_out: false, truncated: false }
              : await sandbox.run(parsed.code);
            content = describeResult(result);
          }

          // The model cannot see the loop it is running inside, so it cannot
          // plan against a budget it was never told. It rides along with the
          // result, which is at the tail of the conversation -- writing it into
          // the tool description instead would rewrite the prompt's prefix every
          // step and throw away the server's cache of it each time.
          const left = MAX_STEPS - 1 - step;
          const budget = left === 1
            ? '\n\n（這是最後一次工具結果，下一次回覆必須給出答案。）'
            : `\n\n（之後還能再呼叫工具 ${left} 次。）`;

          conversation = [...conversation, {
            role: 'tool',
            tool_call_id: call.id,
            // The note is for the model only. `output` below is what the reader
            // sees, and it stays the result itself.
            content: content + budget,
            run: {
              code: shown, tool: heading, result, sources,
              // Only for the tools whose answer is prose. A search's answer is
              // a list of links and is rendered as one.
              output: result || name === 'web_search' ? undefined : content,
            },
          }];
          setTurns([...conversation]);
        }

        // The next step streams into a fresh turn at the end of the list.
        setTurns([...conversation, {
          role: 'assistant', content: '', reasoning: '', model: activeModel,
        }]);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message);
        if (!last?.content) setTurns((prev) => prev.slice(0, -1));
      }
    } finally {
      setStreaming(false);
      setStep(0);
      abort.current = null;

      if (last && (last.content || last.reasoning || last.tool_calls)) {
        const id = await persist(conversation, activeModel);
        const firstUser = history.find((t) => t.role === 'user');
        if (id && isFirstExchange && firstUser && last.content) {
          void generateTitle(id, firstUser, last, activeModel);
        }
      }
    }
  }, [model, agent, sandbox, streamOnce, persist, generateTitle]);

  const send = useCallback((text?: string) => {
    const content = (text ?? draft).trim();
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
    const fromEnd = [...turns].reverse().findIndex((t) => t.role === 'user');
    if (fromEnd < 0) return;
    void run(turns.slice(0, turns.length - fromEnd));
  }, [turns, run]);

  const openConversation = useCallback(async (id: number) => {
    try {
      const chat = await fetchChat(id);
      idRef.current = chat.id;
      setConversationId(chat.id);
      setTurns(chat.messages as Turn[]);
      if (chat.model) setModel((current) => chat.model || current);
      // Restore the settings the conversation was held under, defaulting
      // anything an older record does not carry. Marked as already seeded so
      // the model-change effect does not immediately overwrite them.
      seededFor.current = chat.model || undefined;
      setParams({ ...DEFAULT_PARAMS, ...chat.params });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  /**
   * Take the panel's values from the model's own configuration.
   *
   * Applied over DEFAULT_PARAMS rather than replacing them: a config names a
   * few sampling flags, not the whole panel, and the rest still needs sensible
   * values. `force` is the reset button, which should reseed even when the
   * model has not changed.
   */
  const seedParams = useCallback((info: ModelInfo | undefined, force = false) => {
    if (!info) return;
    if (!force && seededFor.current === info.id) return;
    seededFor.current = info.id;
    setParams((current) => ({
      ...DEFAULT_PARAMS,
      // System prompt and thinking are the user's, not the model's; a config
      // has nothing to say about them and clearing them would be a surprise.
      system: current.system,
      thinking: current.thinking,
      reasoning_budget_tokens: current.reasoning_budget_tokens,
      ...(info.sampling ?? {}),
    }));
  }, []);

  const newConversation = useCallback(() => {
    idRef.current = null;
    setConversationId(null);
    setTurns([]);
    setDraft('');
    setImages([]);
    setError(null);
  }, []);

  const value = useMemo<ChatState>(() => ({
    model, setModel, seedParams, turns, draft, setDraft, images, setImages,
    params, setParams, streaming, agent, setAgent, step,
    streamStartedAt, conversationId, historyKey,
    send, stop: () => abort.current?.abort(), regenerate,
    openConversation, newConversation,
    error, clearError: () => setError(null),
  }), [model, seedParams, turns, draft, images, params, streaming, agent, step,
    streamStartedAt,
       conversationId, historyKey,
       send, regenerate, openConversation, newConversation, error]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatState {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used inside ChatProvider');
  return context;
}
