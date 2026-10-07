import { useEffect, useMemo, useState } from 'react';

/** An item on screen, and whether it is on its way out. */
export interface Present<T> {
  key: string;
  item: T;
  leaving: boolean;
}

/** How long a dropped run stays on screen folding away; bench.css's
 *  bn-close runs a little shorter, so it is gone before it is removed. */
const LEAVE_MS = 280;

/**
 * The items, plus the ones just dropped, kept where they were for as long as
 * they take to fold away. Without this a run unticked from a comparison
 * vanishes in one frame and everything under it jumps up.
 */
export function usePresence<T>(items: T[], keyOf: (item: T) => string): Present<T>[] {
  const sig = items.map(keyOf).join('\u0000');
  const [prev, setPrev] = useState({ sig, items });
  const [leaving, setLeaving] = useState<{ key: string; item: T; at: number }[]>([]);

  // Adjusted during render, as React's docs do for state that follows a
  // prop: an effect would paint one frame with the row already gone.
  if (sig !== prev.sig) {
    const now = new Set(items.map(keyOf));
    const gone = prev.items
      .map((item, at) => ({ key: keyOf(item), item, at }))
      .filter((g) => !now.has(g.key));
    setPrev({ sig, items });
    setLeaving((l) => [
      ...l.filter((x) => !now.has(x.key) && !gone.some((g) => g.key === x.key)),
      ...gone,
    ]);
  }

  useEffect(() => {
    if (!leaving.length) return;
    const keys = new Set(leaving.map((l) => l.key));
    const timer = window.setTimeout(() => setLeaving((l) => l.filter((x) => !keys.has(x.key))), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  // The same array while nothing changes, so what is drawn from it -- the
  // charts' data -- is not rebuilt, and their animation not replayed, on
  // every render.
  return useMemo(() => {
    const out: Present<T>[] = items.map((item) => ({ key: keyOf(item), item, leaving: false }));
    for (const g of [...leaving].sort((a, b) => a.at - b.at)) {
      if (out.some((o) => o.key === g.key)) continue;
      out.splice(Math.min(g.at, out.length), 0, { key: g.key, item: g.item, leaving: true });
    }
    return out;
  }, [items, leaving, keyOf]);
}
