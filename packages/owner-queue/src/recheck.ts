import { relationKind } from "./keys.js";
import type { OwnerAnswer, OwnerItem } from "./schema.js";

export type RecheckFlagKind = "conflict" | "reasked" | "related-answer";

/** An earlier answer the owner should see beside an item it did not settle. */
export interface RecheckFlag {
  itemId: string;
  kind: RecheckFlagKind;
  answerId: string;
  /** The relation keys the item and the answer share, sorted. */
  keys: string[];
}

/** The answer that settled a dropped item. */
export interface RecheckCite {
  answerId: string;
  key: string;
  at: string;
}

export interface RecheckDrop {
  /** The item as it was, with status `gone-elsewhere`. */
  item: OwnerItem;
  cite: RecheckCite;
}

export interface Recheck {
  open: OwnerItem[];
  dropped: RecheckDrop[];
  flags: RecheckFlag[];
}

type Answered = OwnerItem & { answer: OwnerAnswer };

interface Match {
  answer: Answered;
  asks: string[];
  related: string[];
}

function sharedKeys(item: OwnerItem, answer: Answered): Match {
  const theirs = new Set(answer.keys);
  const shared = [...new Set(item.keys.filter((key) => theirs.has(key)))].sort();
  const asks = shared.filter((key) => relationKind(key) === "ask");
  const related = shared.filter((key) => relationKind(key) !== null && relationKind(key) !== "ask");
  return { answer, asks, related };
}

/** PR ref to the head it is pinned at, or null when unpinned. */
function prHeads(keys: readonly string[]): Map<string, string | null> {
  const heads = new Map<string, string | null>();
  for (const key of keys.map((each) => each.toLowerCase()).filter((each) => each.startsWith("pr:"))) {
    const at = key.lastIndexOf("@");
    heads.set(at < 0 ? key : key.slice(0, at), at < 0 ? null : key.slice(at + 1));
  }
  return heads;
}

/**
 * An answer given on another head of a PR the item names is about code the item is not. A PR
 * key with no head pins nothing, as in `stale.ts`, so it never conflicts with a head.
 */
function sameHeads(item: OwnerItem, answer: Answered): boolean {
  const theirs = prHeads(answer.keys);
  return [...prHeads(item.keys)].every(([pr, sha]) => {
    const other = theirs.get(pr);
    return sha === null || other === undefined || other === null || other === sha;
  });
}

function settles(item: OwnerItem, match: Match): boolean {
  return match.asks.length > 0 && Date.parse(match.answer.answer.at) > Date.parse(item.openedAt) && sameHeads(item, match.answer);
}

/** Free text or a change request instead of the recommended pick disagrees with it too. */
function agrees(item: OwnerItem, answer: OwnerAnswer): boolean {
  return item.recommended === undefined || (answer.optionId === item.recommended.optionId && answer.changeRequested !== true);
}

function flagOf(item: OwnerItem, match: Match): RecheckFlag | null {
  const { answer, asks, related } = match;
  if (asks.length > 0) return { itemId: item.id, kind: agrees(item, answer.answer) ? "reasked" : "conflict", answerId: answer.id, keys: asks };
  if (related.length > 0) return { itemId: item.id, kind: "related-answer", answerId: answer.id, keys: related };
  return null;
}

/** Code-unit order, so the output never depends on the runtime's locale. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function newestFirst(a: Match, b: Match): number {
  return Date.parse(b.answer.answer.at) - Date.parse(a.answer.answer.at) || byText(a.answer.id, b.answer.id);
}

function byIdThenOpened(a: OwnerItem, b: OwnerItem): number {
  return byText(a.id, b.id) || Date.parse(a.openedAt) - Date.parse(b.openedAt);
}

function compareFlags(a: RecheckFlag, b: RecheckFlag): number {
  return byText(a.itemId, b.itemId) || byText(a.answerId, b.answerId) || byText(a.kind, b.kind);
}

/**
 * Re-checks open items against answers already given (rule 2). An item is dropped as
 * `gone-elsewhere`, citing the newest such answer, when an answer sharing its `ask:` key is
 * newer than its `openedAt` and pinned to no other head of a PR the item names. An older or
 * other-head answer on the same `ask:` key flags `conflict` when it is not the item's
 * recommendation and `reasked` when it is or there is none. Sharing only a `component:`,
 * `token:` or `topic:` key flags `related-answer` and never drops. Answers are the items
 * carrying an `answer`; others are ignored. Output is sorted, so input order never changes it.
 */
export function recheck(open: readonly OwnerItem[], answered: readonly OwnerItem[]): Recheck {
  const answers = answered.filter((each): each is Answered => each.answer !== undefined);
  const result: Recheck = { open: [], dropped: [], flags: [] };
  for (const item of [...open].sort(byIdThenOpened)) {
    const matches = answers.map((answer) => sharedKeys(item, answer));
    const settling = matches.filter((match) => settles(item, match)).sort(newestFirst)[0];
    if (settling === undefined) {
      result.open.push(item);
      result.flags.push(...matches.flatMap((match) => flagOf(item, match) ?? []));
      continue;
    }
    const cite = { answerId: settling.answer.id, key: settling.asks[0]!, at: settling.answer.answer.at };
    result.dropped.push({ item: { ...item, status: "gone-elsewhere" }, cite });
  }
  result.flags.sort(compareFlags);
  return result;
}
