import type { ItemKind } from "./item.js";
import type { MatrixEvent } from "./types.js";

export const RESOLUTION_EVENT = "io.titan.resolution";

export type Verdict = "allow" | "deny" | "approve" | "dismiss" | "answer";

export interface Resolution {
  itemEventId: string;
  verdict: Verdict;
  text?: string;
}

export interface FoldContext {
  ownerUserId: string;
  /** Open items the caller posted, keyed by event id; the kind picks the verdict vocabulary. */
  itemEventIds: ReadonlyMap<string, ItemKind>;
}

type Family = "yes" | "no";

const REACTION_FAMILY: Record<string, Family> = { "✅": "yes", "👍": "yes", "❌": "no", "👎": "no" };
const WORD_FAMILY: Record<string, Family> = { allow: "yes", approve: "yes", deny: "no", dismiss: "no" };

// Section 4.3: what each family means per kind; a missing entry means the action does not resolve that kind.
const VERDICTS: Record<ItemKind, Partial<Record<Family, Verdict>>> = {
  approval_request: { yes: "allow", no: "deny" },
  endorse_request: { yes: "approve", no: "dismiss" },
  question: { no: "dismiss" },
  notice: { yes: "dismiss", no: "dismiss" },
  message: { yes: "dismiss", no: "dismiss" },
};

// Variation selectors and skin-tone modifiers, so 👍🏽 counts as 👍.
const EMOJI_MODIFIERS = /\uFE0E|\uFE0F|\p{Emoji_Modifier}/gu;

function relatesTo(content: Record<string, unknown>): Record<string, unknown> {
  const rel = content["m.relates_to"];
  return typeof rel === "object" && rel !== null ? (rel as Record<string, unknown>) : {};
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function foldReaction(content: Record<string, unknown>, kind: ItemKind, itemEventId: string): Resolution | null {
  const key = stringField(relatesTo(content), "key")?.replace(EMOJI_MODIFIERS, "");
  const family = key === undefined ? undefined : REACTION_FAMILY[key];
  const verdict = family && VERDICTS[kind][family];
  return verdict ? { itemEventId, verdict } : null;
}

// Drops a legacy reply fallback ("> <@owner> quoted" lines plus one blank line) from the top of a body.
export function stripReplyFallback(body: string): string {
  const lines = body.split("\n");
  let start = 0;
  while (start < lines.length && lines[start]?.startsWith(">")) start += 1;
  if (start > 0 && lines[start]?.trim() === "") start += 1;
  return lines.slice(start).join("\n").trim();
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").toLowerCase();
}

function foldWords(text: string, kind: ItemKind, itemEventId: string): Resolution | null {
  const family = WORD_FAMILY[lastLine(text)];
  const verdict = family && VERDICTS[kind][family];
  if (verdict) return { itemEventId, verdict };
  if (kind === "question" && text) return { itemEventId, verdict: "answer", text };
  return null;
}

function foldReply(content: Record<string, unknown>, kind: ItemKind, itemEventId: string): Resolution | null {
  const body = stringField(content, "body");
  return body === undefined ? null : foldWords(stripReplyFallback(body), kind, itemEventId);
}

function foldDecision(content: Record<string, unknown>, kind: ItemKind, itemEventId: string): Resolution | null {
  const decision = stringField(content, "decision");
  if (decision === "answer") {
    const text = stringField(content, "text")?.trim();
    return kind === "question" && text ? { itemEventId, verdict: "answer", text } : null;
  }
  const family = decision === undefined ? undefined : WORD_FAMILY[decision];
  const verdict = family && VERDICTS[kind][family];
  return verdict ? { itemEventId, verdict } : null;
}

function targetOf(event: MatrixEvent): string | undefined {
  const rel = relatesTo(event.content);
  if (event.type === "m.reaction") return rel.rel_type === "m.annotation" ? stringField(rel, "event_id") : undefined;
  if (event.type === "m.room.message") return stringField(rel["m.in_reply_to"], "event_id");
  if (event.type === RESOLUTION_EVENT) return stringField(rel, "event_id");
  return undefined;
}

/** Folds an owner's reaction, reply or io.titan.resolution into a verdict on an open item; anything else is null. */
export function foldResolution(event: MatrixEvent, { ownerUserId, itemEventIds }: FoldContext): Resolution | null {
  if (event.sender !== ownerUserId || event.state_key !== undefined) return null;
  const itemEventId = targetOf(event);
  const kind = itemEventId === undefined ? undefined : itemEventIds.get(itemEventId);
  if (itemEventId === undefined || kind === undefined) return null;
  if (event.type === "m.reaction") return foldReaction(event.content, kind, itemEventId);
  if (event.type === "m.room.message") return foldReply(event.content, kind, itemEventId);
  return foldDecision(event.content, kind, itemEventId);
}
