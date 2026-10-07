import { createContext, useContext } from 'react';
import type { BenchProgress } from './api';

/**
 * Where the benchmark stands, for the whole app.
 *
 * One poll for everyone: the shell's banner, the chat's input and the bench
 * drawer all ask the same question, and each asking on its own would triple
 * the requests for an answer that is the same for all three. The provider
 * (components/BenchStatusProvider) polls slowly while nothing runs and once a
 * second while something does.
 */
export interface BenchStatusState {
  /** Null until the first answer, and while the backend has no bench (an
   *  older backend answers 404): both read as idle. */
  status: BenchProgress | null;
  /** Asks again now, after starting or cancelling, rather than waiting for
   *  the next tick. Resolves with the answer. */
  refresh: () => Promise<BenchProgress | null>;
}

export const BenchStatusContext = createContext<BenchStatusState>({
  status: null,
  refresh: () => Promise.resolve(null),
});

export const useBenchStatus = () => useContext(BenchStatusContext);

/** /v1 is held: requests are being drained or the suite is running. */
export function benchActive(status: BenchProgress | null | undefined): boolean {
  return status?.state === 'draining' || status?.state === 'running';
}

export function clockHM(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString('zh-TW', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** What every signed-in user is told while a run holds /v1. */
export function pauseMessage(status: BenchProgress | null | undefined): string {
  const when = status?.resume_at ? `，預計 ${clockHM(status.resume_at)} 恢復` : '';
  return `主控台正在跑分，對外 API 暫停中${when}`;
}
