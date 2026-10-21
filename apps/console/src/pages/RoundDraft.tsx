import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert } from "@titan-design/react-ui";
import { clearDraft, emptyDraft, loadDraft, saveDraft, type DraftAnswers, type LoadedDraft } from "./round-draft.js";

/** Which round a page's draft belongs to, and whether it may still keep one. */
export interface DraftBinding {
  roundId: string;
  manifestSha256: string;
  /** Sent, by an earlier visit or this one, or withdrawn: nothing is restored and the stored draft is dropped. */
  closed: boolean;
}

const WRITE_DELAY_MS = 300;

const storage = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The draft the page starts from, read once on mount; a closed round, or a page with no binding, restores none. */
export function useDraftSeed(binding: DraftBinding | undefined): LoadedDraft {
  const [loaded] = useState((): LoadedDraft => {
    const store = storage();
    if (binding === undefined || binding.closed || store === undefined) return { discarded: false };
    return loadDraft(store, binding.roundId, binding.manifestSha256);
  });
  return loaded;
}

function persist(binding: DraftBinding, draft: DraftAnswers): void {
  const store = storage();
  if (store === undefined) return;
  if (binding.closed || emptyDraft(draft)) clearDraft(store, binding.roundId);
  else saveDraft(store, binding.roundId, binding.manifestSha256, draft);
}

/**
 * Writes the page's draft a moment after each change, and at once when the round closes, which clears it. Leaving the
 * page writes a pending change rather than losing it.
 */
export function useDraftWrite(binding: DraftBinding | undefined, draft: DraftAnswers): void {
  const latest = useRef({ binding, draft });
  useEffect(() => {
    latest.current = { binding, draft };
    if (binding === undefined) return;
    if (binding.closed) return persist(binding, draft);
    const timer = setTimeout(() => persist(binding, draft), WRITE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [binding, draft]);
  useEffect(
    () => () => {
      const { binding: last, draft: pending } = latest.current;
      if (last !== undefined) persist(last, pending);
    },
    [],
  );
}

export function DraftDiscarded({ discarded }: { discarded: boolean }): ReactNode {
  return discarded ? <Alert status="info" message="Draft from an older version discarded" /> : null;
}
