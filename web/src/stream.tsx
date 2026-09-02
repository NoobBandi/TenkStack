import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  fetchModels, subscribe,
  type GpuSample, type InflightRequest, type ModelInfo,
  type ProgressTick, type StreamEvent, type SystemSample, type Throughput,
} from './api';

/**
 * One SSE connection for the whole app.
 *
 * Every page wants some slice of the same stream — the sidebar wants GPU load,
 * the dashboard wants telemetry, chat wants model state. Subscribing per component
 * would open a connection each, and each connection costs a backend task
 * polling xpu-smi.
 */

/** One request's progress, accumulated from its ticks.
 *
 *  `tokens` is cumulative across both phases -- prefill contributes the prompt
 *  it ingested, decode the tokens it generated -- because both are the same
 *  measure: work this request put through the model. The kink where the slope
 *  drops is the moment prefill ended, which is also where time-to-first-token
 *  lands, so the curve says it without an annotation.
 *
 *  A prompt small enough that llama-server never printed a prefill tick starts
 *  the curve at zero. That is honest: the prefill was too short to observe, not
 *  hidden.
 */
export interface RequestTrace {
  key: string;
  slot: number;
  task: number;
  startedAt: number;
  updatedAt: number;
  promptTokens: number;
  points: { at: number; tokens: number; rate: number; phase: 'prefill' | 'decode' }[];
  done: boolean;
  truncated: boolean;
  /** Whole window the request ended up occupying, prompt included. */
  finalTokens: number;
}

/** Enough to show the live one and the few before it; a dashboard block cannot
 *  read more than that, and an unbounded list is a leak on a page left open. */
const TRACE_LIMIT = 6;

interface StreamState {
  /** Every installed GPU, lowest index first. */
  gpus: GpuSample[];
  system: SystemSample | null;
  models: ModelInfo[];
  throughput: Throughput | null;
  traces: RequestTrace[];
  requests: InflightRequest[];
  connected: boolean;
  refreshModels: () => void;
}

const StreamContext = createContext<StreamState | null>(null);

export function StreamProvider({ children }: { children: React.ReactNode }) {
  const [gpus, setGpus] = useState<GpuSample[]>([]);
  const [system, setSystem] = useState<SystemSample | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [throughput, setThroughput] = useState<Throughput | null>(null);
  const [traces, setTraces] = useState<RequestTrace[]>([]);
  const [requests, setRequests] = useState<InflightRequest[]>([]);
  const [connected, setConnected] = useState(true);

  const refreshModels = useMemo(
    () => () => { fetchModels().then(setModels).catch(() => undefined); },
    [],
  );

  useEffect(() => { refreshModels(); }, [refreshModels]);

  useEffect(() => {
    const unsubscribe = subscribe((event: StreamEvent) => {
      switch (event.type) {
        case 'gpu':
          setGpus(event.data as GpuSample[]);
          break;
        case 'system':
          setSystem(event.data as SystemSample);
          break;
        case 'throughput':
          setThroughput(event.data as Throughput);
          break;
        case 'progress': {
          const tick = event.data as ProgressTick;
          const key = `${tick.slot}:${tick.task}`;
          const at = Date.now();
          setTraces((prev) => {
            const existing = prev.find((t) => t.key === key);
            const rest = prev.filter((t) => t.key !== key);
            const base: RequestTrace = existing ?? {
              key, slot: tick.slot, task: tick.task,
              startedAt: at, updatedAt: at, promptTokens: 0,
              points: [], done: false, truncated: false, finalTokens: 0,
            };

            if (tick.phase === 'done') {
              // A request short enough to finish between progress ticks has no
              // points at all, and a trace with nothing to draw is a row that
              // says nothing. Dropped rather than kept as an empty one.
              if (!existing) return prev;
              return [...rest, {
                ...base, updatedAt: at, done: true,
                truncated: !!tick.truncated, finalTokens: tick.tokens,
              }].slice(-TRACE_LIMIT);
            }

            // Prefill reports the prompt it has taken in so far; decode counts
            // only what it has generated, so the prompt is carried across as
            // the offset that keeps one curve continuous.
            const promptTokens = tick.phase === 'prefill'
              ? Math.max(base.promptTokens, tick.tokens) : base.promptTokens;
            const cumulative = tick.phase === 'prefill'
              ? tick.tokens : promptTokens + tick.tokens;

            return [...rest, {
              ...base, updatedAt: at, promptTokens,
              points: [...base.points, {
                at, tokens: cumulative, rate: tick.rate ?? 0, phase: tick.phase,
              }].slice(-400),
            }].slice(-TRACE_LIMIT);
          });
          break;
        }
        case 'modelStatus': {
          const next = event.data as ModelInfo[];
          // A full array on every change, not a delta. Capabilities and
          // ctx_size are not in this payload, so they are carried over from
          // the REST fetch rather than being dropped on every status change.
          setModels((prev) => next.map((m) => {
            const existing = prev.find((p) => p.id === m.id);
            return {
              ...existing,
              ...m,
              running: m.state === 'ready' || m.state === 'starting',
            };
          }));
          break;
        }
        case 'inflight': {
          const payload = event.data as { operation: string; request?: InflightRequest };
          if (payload.operation === 'snapshot' && !payload.request) {
            setRequests([]);
            break;
          }
          if (!payload.request) break;
          const incoming = { ...payload.request, updated_at: Date.now() };
          setRequests((prev) => {
            const rest = prev.filter((r) => r.id !== incoming.id);
            // Keep the list short: only recent requests are ever displayed.
            return [...rest, incoming].slice(-20);
          });
          break;
        }
        // logData is still emitted, but nothing here keeps it: the log page
        // reads the journal instead, which carries every service rather than
        // just llama-swap, and real severities rather than guessed ones. The
        // event is left alone because the backend parses throughput out of it.
        default:
          break;
      }
    }, setConnected);

    return unsubscribe;
  }, []);

  // Model status arrives on the stream, but capabilities and context size only
  // come from REST, so a periodic refetch keeps them current after a reload.
  useEffect(() => {
    const timer = window.setInterval(refreshModels, 15000);
    return () => window.clearInterval(timer);
  }, [refreshModels]);

  const value = useMemo<StreamState>(() => ({
    gpus, system, models, throughput, traces, requests, connected,
    refreshModels,
  }), [gpus, system, models, throughput, traces, requests, connected, refreshModels]);

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

export function useStream(): StreamState {
  const context = useContext(StreamContext);
  if (!context) throw new Error('useStream must be used inside StreamProvider');
  return context;
}
