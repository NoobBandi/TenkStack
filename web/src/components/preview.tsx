import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * Which code block the preview panel is showing.
 *
 * The panel lives at the page edge but is opened from a button inside a reply,
 * arbitrarily deep in the Markdown tree, so the two cannot be wired together by
 * props: react-markdown builds the elements between them and has nowhere to
 * thread a callback through. A context is the join.
 */

export interface PreviewTarget {
  source: string;
  language: string;
  /** Bumped on re-run; used as the frame key so the document starts over. */
  runId: number;
}

interface PreviewApi {
  target: PreviewTarget | null;
  open: (source: string, language: string) => void;
  rerun: () => void;
  close: () => void;
}

const PreviewContext = createContext<PreviewApi | null>(null);

/** Null outside a provider, so a run button simply does not appear there. */
export function usePreview(): PreviewApi | null {
  return useContext(PreviewContext);
}

export function PreviewProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<PreviewTarget | null>(null);

  const open = useCallback((source: string, language: string) => {
    // A new run always gets a fresh id, including for the block already shown:
    // pressing run on the same code twice should reload it, not do nothing.
    setTarget((prev) => ({ source, language, runId: (prev?.runId ?? 0) + 1 }));
  }, []);

  const rerun = useCallback(() => {
    setTarget((prev) => (prev ? { ...prev, runId: prev.runId + 1 } : prev));
  }, []);

  const close = useCallback(() => setTarget(null), []);

  const api = useMemo(() => ({ target, open, rerun, close }), [target, open, rerun, close]);

  return <PreviewContext.Provider value={api}>{children}</PreviewContext.Provider>;
}
