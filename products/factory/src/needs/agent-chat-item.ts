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
  question: { kind: "decide", door: "two-way", lens: "blocking-agent" },
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

/** A one-way row stays an approval whatever its meta says, so nothing reshapes it into a decision the decider could take. */
function shapeOf(row: QueueRow): Shape {
  const base = BY_BROKER_KIND[row.kind] ?? FYI;
  if (base.door === "one-way") return base;
  const itemKind = row.meta["kind"];
  return itemKind && BY_ITEM_KIND[itemKind] ? { ...base, ...BY_ITEM_KIND[itemKind] } : base;
}

function optionsOf(meta: Record<string, string>): string[] {
  try {
    const parsed: unknown = JSON.parse(meta["options"] ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((o): o is string => typeof o === "string" && o.trim() !== "") : [];
  } catch {
    return [];
  }
}

/** Option ids are the labels, so an answer by option id is the text the broker records. */
function choicesOf(row: QueueRow): Pick<OwnerItem, "options" | "recommended"> {
  const labels = [...new Set(optionsOf(row.meta))];
  if (labels.length < 2 || labels.length > 8) return {};
  const pick = row.meta["recommended"];
  return {
    options: labels.map((label) => ({ id: label, label })),
    ...(pick && labels.includes(pick) && { recommended: { optionId: pick, by: row.from || "agent-chat" } }),
  };
}

function contextOf(row: QueueRow): string {
  const notes = [
    row.meta["recommended"] && `Recommended: ${row.meta["recommended"]}`,
    row.meta["on_no_answer"] && `If no answer: ${row.meta["on_no_answer"]}`,
  ].filter(Boolean);
  return [row.text, ...notes].join("\n");
}

/** Task and run keys only: a PR named in free text has no head sha, so it could never merge. */
function keysOf(row: QueueRow): string[] {
  const task = row.meta["task"];
  const runs = keysIn(row.text).filter((key) => key.startsWith("run:"));
  return [...new Set([...(task ? [`task:${task}`] : []), ...runs])];
}

export function toOwnerItem(row: QueueRow): OwnerItem {
  return {
    id: `chat:${row.msgId}`,
    sources: [{ system: "agent-chat", ref: row.msgId }],
    ...shapeOf(row),
    summary: summaryOf(row.text, `${row.kind} from ${row.from || "an agent"}`),
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
