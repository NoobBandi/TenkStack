import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  fetchModels, subscribe,
  type GpuSample, type InflightRequest, type ModelInfo,
  type StreamEvent, type SystemSample, type Throughput,
} from './api';

/**
 * One SSE connection for the whole app.
 *
 * Every page wants some slice of the same stream — the sidebar wants GPU load,
 * the dashboard wants telemetry, chat wants model state. Subscribing per component
 * would open a connection each, and each connection costs a backend task
 * polling xpu-smi.
 */

interface StreamState {
  /** Every installed GPU, lowest index first. */
  gpus: GpuSample[];
  system: SystemSample | null;
  models: ModelInfo[];
  throughput: Throughput | null;
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
    gpus, system, models, throughput, requests, connected,
    refreshModels,
  }), [gpus, system, models, throughput, requests, connected, refreshModels]);

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

export function useStream(): StreamState {
  const context = useContext(StreamContext);
  if (!context) throw new Error('useStream must be used inside StreamProvider');
  return context;
}
