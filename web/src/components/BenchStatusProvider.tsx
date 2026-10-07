import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { benchStatus, type BenchProgress } from '../api';
import { BenchStatusContext, benchActive } from '../benchState';

/** Idle, nothing to watch closely: the banner can be five seconds late. */
const IDLE_MS = 5000;
/** A run holds /v1: the drawer's progress and the banner follow it closely. */
const ACTIVE_MS = 1000;
/** The status endpoint failed (an older backend without a bench, or the
 *  backend restarting): ask rarely rather than every five seconds. */
const FAILED_MS = 30000;

export default function BenchStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<BenchProgress | null>(null);
  const [failed, setFailed] = useState(false);
  // The interval is chosen from the latest answer, which the effect below
  // must not depend on directly or every answer would restart the timer.
  const latest = useRef<BenchProgress | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await benchStatus();
      latest.current = next;
      setStatus(next);
      setFailed(false);
      return next;
    } catch {
      latest.current = null;
      setStatus(null);
      setFailed(true);
      return null;
    }
  }, []);

  const active = benchActive(status);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const every = active ? ACTIVE_MS : failed ? FAILED_MS : IDLE_MS;
    const timer = window.setInterval(() => {
      // A tab in the background has nobody reading the banner; while a run is
      // active it still follows, so coming back to it is not five seconds stale.
      if (document.hidden && !benchActive(latest.current)) return;
      void refresh();
    }, every);
    return () => window.clearInterval(timer);
  }, [active, failed, refresh]);

  const value = useMemo(() => ({ status, refresh }), [status, refresh]);
  return <BenchStatusContext.Provider value={value}>{children}</BenchStatusContext.Provider>;
}
