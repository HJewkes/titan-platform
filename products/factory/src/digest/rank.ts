import { keysIn } from "./keys.js";
import type { Ask, DigestModel, Merged, Stuck } from "./model.js";

export interface Caps {
  needsYou: number;
  merged: number;
  stuck: number;
  decided: number;
  /** Decisions are notices, so they get only the words the other sections leave under this limit. */
  words: number;
}

/** A seat's morning queue can hold 30 items, so asks are capped too, or one queue alone breaks the 400-word read. */
export const DEFAULT_CAPS: Caps = { needsYou: 10, merged: 5, stuck: 5, decided: 5, words: 400 };
export const NO_CAPS: Caps = { needsYou: Infinity, merged: Infinity, stuck: Infinity, decided: Infinity, words: Infinity };

/** The model as the reader sees it: asks merged, lists ordered and capped, with the totals the caps hid. Asks keep source order: factory gates, then seat queues, then agent-chat. */
export interface RankedDigest extends DigestModel {
  totals: { needsYou: number; merged: number; stuck: number; decided: number };
  overflow: number;
  wordLimit: number;
}

/** The first source to name a PR or run wins, so a factory gate (exact command) beats a queue line about the same PR; an ask that also names something new stays, so two gates on one PR, keyed `gate:<id>`, stay two asks. */
export function dedupeAsks(asks: readonly Ask[]): Ask[] {
  const kept: Ask[] = [];
  const seen = new Set<string>();
  for (const ask of asks) {
    const duplicate = ask.keys.length > 0 && ask.keys.every((key) => seen.has(key));
    for (const key of ask.keys) seen.add(key);
    if (!duplicate) kept.push(ask);
  }
  return kept;
}

function dedupeMerged(merged: readonly Merged[]): Merged[] {
  const seen = new Set<string>();
  return merged.filter((item) => {
    const key = keysIn(item.ref)[0] ?? item.ref;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const newestFirst = (a: Merged, b: Merged): number => (b.at ?? "").localeCompare(a.at ?? "");
const oldestFirst = (a: Stuck, b: Stuck): number => a.since.localeCompare(b.since);

export function rankDigest(model: DigestModel, caps: Caps = DEFAULT_CAPS): RankedDigest {
  const asks = dedupeAsks(model.needsYou);
  const merged = dedupeMerged(model.merged).sort(newestFirst);
  const stuck = [...model.stuck].sort(oldestFirst);
  const decided = model.decided ?? [];
  const shown = { needsYou: asks.slice(0, caps.needsYou), merged: merged.slice(0, caps.merged), stuck: stuck.slice(0, caps.stuck) };
  const totals = { needsYou: asks.length, merged: merged.length, stuck: stuck.length, decided: decided.length };
  const hidden = totals.needsYou - shown.needsYou.length + totals.merged - shown.merged.length + totals.stuck - shown.stuck.length;
  const shownDecided = decided.slice(0, caps.decided);
  return { ...model, ...shown, ...(model.decided && { decided: shownDecided }), totals, overflow: hidden + decided.length - shownDecided.length, wordLimit: caps.words };
}
