import type { OwnerItem } from "@titan-design/owner-queue";
import { z } from "zod";
import { keysIn } from "../digest/keys.js";
import { summaryOf } from "./queue-read-error.js";

/** One row of agent-chat's `GET /api/queue` (its `QueueItem`); `meta` carries the optional chat_ask item shape. */
const queueRowSchema = z.object({
  msgId: z.string().min(1),
  kind: z.string().min(1),
  from: z.string(),
  text: z.string(),
  at: z.number(),
  meta: z.record(z.string(), z.string()),
});

export const queueResponseSchema = z.object({ items: z.array(queueRowSchema) });

export type QueueRow = z.infer<typeof queueRowSchema>;

type Shape = Pick<OwnerItem, "kind" | "door" | "lens">;

const FYI: Shape = { kind: "know", door: "two-way", lens: "fyi" };

/** Permission prompts and endorsements are one-way approvals the asking agent waits on. */
const BY_BROKER_KIND: Record<string, Shape> = {
  question: { kind: "decide", door: "one-way", lens: "blocking-agent" },
  approval_request: { kind: "approve", door: "one-way", lens: "blocking-agent" },
  endorse_request: { kind: "approve", door: "one-way", lens: "blocking-agent" },
};

/** A notice or message that carries an item shape is an ask, not news. */
const BY_ITEM_KIND: Record<string, Pick<OwnerItem, "kind" | "lens">> = {
  decision: { kind: "decide", lens: "blocking-agent" },
  "needs-grant": { kind: "approve", lens: "blocking-agent" },
  stalled: { kind: "decide", lens: "stuck" },
  "ready-to-merge": { kind: "approve", lens: "blocking-merge" },
};

/** An undeclared or unknown door is one-way, so a decider never takes an ask its asker did not mark reversible. */
function declaredDoor(meta: Record<string, string>): OwnerItem["door"] {
  return meta["door"] === "two-way" ? "two-way" : "one-way";
}

/**
 * A permission prompt or endorsement stays a one-way approval whatever its meta says, so nothing reshapes it
 * into a decision the decider could take. Only a question takes its door from meta.
 */
function shapeOf(row: QueueRow): Shape {
  const base = BY_BROKER_KIND[row.kind] ?? FYI;
  if (row.kind === "approval_request" || row.kind === "endorse_request") return base;
  const itemKind = row.meta["kind"];
  const shaped = itemKind && BY_ITEM_KIND[itemKind] ? { ...base, ...BY_ITEM_KIND[itemKind] } : base;
  return row.kind === "question" ? { ...shaped, door: declaredDoor(row.meta) } : shaped;
}

function stringsOf(meta: Record<string, string>, key: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(meta[key] ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function optionsOf(meta: Record<string, string>): string[] {
  return stringsOf(meta, "options").filter((o): o is string => typeof o === "string" && o.trim() !== "");
}

/** Descriptions align with the raw `options` array by index, so they are paired before any label is dropped. */
function describedOptions(meta: Record<string, string>): NonNullable<OwnerItem["options"]> {
  const descriptions = stringsOf(meta, "option_descriptions");
  const byLabel = new Map<string, string>();
  stringsOf(meta, "options").forEach((label, i) => {
    const description = descriptions[i];
    if (typeof label === "string" && typeof description === "string" && description.trim() !== "" && !byLabel.has(label)) byLabel.set(label, description);
  });
  return [...new Set(optionsOf(meta))].map((label) => {
    const description = byLabel.get(label);
    return { id: label, label, ...(description && { description }) };
  });
}

/** Option ids are the labels, so an answer by option id is the text the broker records. */
function choicesOf(row: QueueRow): Pick<OwnerItem, "options" | "recommended" | "default"> {
  const options = describedOptions(row.meta);
  if (options.length < 2 || options.length > 8) return {};
  const isLabel = (value: string | undefined): value is string => !!value && options.some((o) => o.id === value);
  const pick = row.meta["recommended"];
  const fallback = row.meta["default"];
  return {
    options,
    ...(isLabel(pick) && { recommended: { optionId: pick, by: row.from || "agent-chat" } }),
    ...(isLabel(fallback) && { default: fallback }),
  };
}

function contextOf(row: QueueRow): string {
  const notes = [
    row.meta["recommended"] && `Recommended: ${row.meta["recommended"]}`,
    row.meta["on_no_answer"] && `If no answer: ${row.meta["on_no_answer"]}`,
    row.meta["blocking"] === "parked" && "Asker is parked on this",
    row.meta["reversible"] && `Reversible: ${row.meta["reversible"]}`,
  ].filter(Boolean);
  return [row.text, ...notes].join("\n");
}

/** The gate notifier files its asks with `task: "gate:<id>"`, so the ask keys as the hitl gate item it merges with. */
function taskKey(task: string): string {
  return task.startsWith("gate:") ? task : `task:${task}`;
}

/** Task and run keys only: a PR named in free text has no head sha, so it could never merge. */
function keysOf(row: QueueRow): string[] {
  const task = row.meta["task"];
  const runs = keysIn(row.text).filter((key) => key.startsWith("run:"));
  return [...new Set([...(task ? [taskKey(task)] : []), ...runs])];
}

/** Category and initiative are routing inputs for ingest; blank values are left off so the schema's min(1) holds. */
function routingOf(meta: Record<string, string>): Pick<OwnerItem, "category" | "initiative"> {
  const category = meta["category"]?.trim();
  const initiative = meta["initiative"]?.trim();
  return { ...(category && { category }), ...(initiative && { initiative }) };
}

export function toOwnerItem(row: QueueRow): OwnerItem {
  const header = row.meta["header"]?.trim();
  return {
    id: `chat:${row.msgId}`,
    sources: [{ system: "agent-chat", ref: row.msgId }],
    ...shapeOf(row),
    ...routingOf(row.meta),
    summary: summaryOf(header || row.text, `${row.kind} from ${row.from || "an agent"}`),
    context: contextOf(row),
    ...choicesOf(row),
    keys: keysOf(row),
    ...(row.from && { asker: row.from }),
    personal: false,
    unblocks: [],
    openedAt: new Date(row.at).toISOString(),
    status: "open",
  };
}
