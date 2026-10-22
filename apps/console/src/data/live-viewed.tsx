/**
 * The story variants whose live frame rendered on this round's page, sent with `rounds.submit` so the
 * decision log can tell an approval made from the PNG from one made after live exploration (TP-3793 S7).
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const LiveViewed = createContext<Set<string> | null>(null);

/** One per round page; keyed by round id, it starts empty for each round. */
export function LiveViewedProvider({ children }: { children: ReactNode }): ReactNode {
  const [viewed] = useState(() => new Set<string>());
  return <LiveViewed.Provider value={viewed}>{children}</LiveViewed.Provider>;
}

/** Marks a variant as viewed live; a no-op outside a provider. */
export function useMarkLiveViewed(): (key: string) => void {
  const viewed = useContext(LiveViewed);
  return useCallback((key: string) => void viewed?.add(key), [viewed]);
}

/** The keys viewed live so far, read at submit time; undefined when none were, so the submit leaves the field out. */
export function useLiveViewed(): () => string[] | undefined {
  const viewed = useContext(LiveViewed);
  return useCallback(() => (viewed === null || viewed.size === 0 ? undefined : [...viewed]), [viewed]);
}
