import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
} from 'react';
import {
  chatStream, DEFAULT_PARAMS, fetchChat, patchChat, saveChat,
  type ChatMessage, type ChatParams, type Timings, type Usage,
} from './api';

/**
 * The conversation, held above the router.
 *
 * A page component unmounts when the user navigates, taking its state and its
 * in-flight fetch with it — leaving the chat page mid-answer used to lose the
 * answer. Owning the session here means switching to the dashboard and back
 * finds the reply still streaming.
 */

export interface Turn extends ChatMessage {
  usage?: Usage;
  timings?: Timings;
  finish_reason?: string;
  /** Which model produced this reply; a thread can be continued by another. */
  model?: string;
  ttft_ms?: number;
  /** Wall time spent inside the reasoning block, first thought to first word.
   *  A collapsed trace says nothing about what it cost; this does. */
  thinking_ms?: number;
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
  turns: Turn[];
  draft: string;
  setDraft: (v: string) => void;
  images: string[];
  setImages: (v: string[]) => void;
  params: ChatParams;
  setParams: (p: ChatParams) => void;
  streaming: boolean;
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
  const [streaming, setStreaming] = useState(false);
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

  const run = useCallback(async (history: Turn[]) => {
    if (!model) return;
    const activeModel = model;

    // Save before generating: a question asked is worth keeping even if the
    // answer never arrives, and the history list should show the thread the
    // moment it starts rather than when it finishes.
    const isFirstExchange = history.filter((t) => t.role === 'user').length === 1;
    void persist(history, activeModel);

    setTurns([...history, { role: 'assistant', content: '', reasoning: '', model: activeModel }]);
    setStreaming(true);
    setError(null);

    const controller = new AbortController();
    abort.current = controller;
    const startedAt = performance.now();
    setStreamStartedAt(startedAt);
    let ttft: number | undefined;
    // The reasoning block runs from its first token to the first word of the
    // answer, so it can only be closed out when the answer starts.
    let reasoningAt: number | undefined;
    let thinkingMs: number | undefined;

    // Deltas accumulate outside React so no token is dropped even though most
    // of them never trigger a render.
    const pending: Partial<Turn> = {};
    let content = '';
    let reasoning = '';
    let lastFlush = 0;

    const flush = () => {
      lastFlush = performance.now();
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          ...next[next.length - 1], ...pending,
          content, reasoning, ttft_ms: ttft, thinking_ms: thinkingMs,
          model: activeModel,
        };
        return next;
      });
    };

    try {
      for await (const delta of chatStream({
        model: activeModel, messages: history, params, signal: controller.signal,
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
        if (delta.usage) pending.usage = delta.usage;
        if (delta.timings) pending.timings = delta.timings;
        if (delta.finish_reason) pending.finish_reason = delta.finish_reason;
        if (performance.now() - lastFlush >= FLUSH_INTERVAL_MS) flush();
      }
      flush();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message);
        if (content) flush(); else setTurns((prev) => prev.slice(0, -1));
      }
    } finally {
      setStreaming(false);
      abort.current = null;

      if (content || reasoning) {
        // A reply that was all reasoning and no answer still spent the time.
        if (thinkingMs === undefined && reasoningAt !== undefined) {
          thinkingMs = performance.now() - reasoningAt;
        }
        const reply: Turn = {
          role: 'assistant', content, reasoning, ...pending,
          ttft_ms: ttft, thinking_ms: thinkingMs, model: activeModel,
        };
        const id = await persist([...history, reply], activeModel);
        const firstUser = history.find((t) => t.role === 'user');
        if (id && isFirstExchange && firstUser) {
          void generateTitle(id, firstUser, reply, activeModel);
        }
      }
    }
  }, [model, params, persist, generateTitle]);

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
      // anything an older record does not carry.
      setParams({ ...DEFAULT_PARAMS, ...chat.params });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
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
    model, setModel, turns, draft, setDraft, images, setImages,
    params, setParams, streaming, streamStartedAt, conversationId, historyKey,
    send, stop: () => abort.current?.abort(), regenerate,
    openConversation, newConversation,
    error, clearError: () => setError(null),
  }), [model, turns, draft, images, params, streaming, streamStartedAt,
       conversationId, historyKey,
       send, regenerate, openConversation, newConversation, error]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatState {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used inside ChatProvider');
  return context;
}
