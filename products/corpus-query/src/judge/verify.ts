import { quoteInText, scoreControls, type ControlScore } from "@titan-design/evidence";
import type { Batch } from "./batch.js";
import { MAX_QUOTE_WORDS } from "./verdict.js";

export type VoidReason = "unknown-id" | "quote-too-long" | "quote-not-in-passage" | "quote-unverifiable";

export interface Voided {
  id: string;
  reason: VoidReason;
}

export interface QuotedItem {
  id: string;
  quote: string;
}

export interface VerifiedBatch<T extends QuotedItem> {
  items: T[];
  voided: Voided[];
  /** Passages the verdict's `judged` list omits; they count as unjudged. */
  unjudged: string[];
  canary?: ControlScore;
  /** True when the canary was mis-judged, so the batch's verdict is not trusted. */
  flagged: boolean;
}

const wordCount = (quote: string): number => quote.split(/\s+/).filter(Boolean).length;

function voidReason(text: string | undefined, quote: string): VoidReason | undefined {
  if (text === undefined) return "unknown-id";
  if (wordCount(quote) > MAX_QUOTE_WORDS) return "quote-too-long";
  const found = quoteInText(text, quote);
  if (found === null) return "quote-unverifiable";
  return found ? undefined : "quote-not-in-passage";
}

function scoreCanary<T extends QuotedItem>(batch: Batch, judged: ReadonlySet<string>, items: readonly T[]) {
  const { canary } = batch;
  if (!canary) return undefined;
  const flagged = items.some((item) => item.id === canary.id);
  const answered = flagged ? "match" : judged.has(canary.id) ? "no-match" : undefined;
  return scoreControls(
    [{ id: canary.id, label: canary.expect }],
    answered === undefined ? [] : [{ id: canary.id, label: answered }],
  );
}

/**
 * Checks a verdict against the passages the batch showed. A quote counts only for the passage
 * it is reported on, so a real sentence cited for the wrong passage is void.
 */
export function verifyVerdict<T extends QuotedItem>(
  batch: Batch,
  verdict: { judged: readonly string[]; items: readonly T[] },
): VerifiedBatch<T> {
  const shown = new Map(batch.passages.map((p) => [p.id, p.text]));
  if (batch.canary) shown.set(batch.canary.id, batch.canary.text);
  const items: T[] = [];
  const voided: Voided[] = [];
  for (const item of verdict.items) {
    const reason = voidReason(shown.get(item.id), item.quote);
    if (reason) voided.push({ id: item.id, reason });
    else items.push(item);
  }
  const judged = new Set(verdict.judged);
  const unjudged = batch.passages.map((p) => p.id).filter((id) => !judged.has(id));
  const canary = scoreCanary(batch, judged, items);
  const canaryId = batch.canary?.id;
  return {
    items: items.filter((item) => item.id !== canaryId),
    voided,
    unjudged,
    canary,
    flagged: canary !== undefined && canary.correct < canary.total,
  };
}
