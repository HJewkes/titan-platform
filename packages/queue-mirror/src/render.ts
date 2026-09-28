import { MAX_CONTENT_BYTES, contentBytes, encodeItem, type ItemInput } from "@titan-design/matrix-bus";
import { redactPreview } from "./redact.js";
import type { QueueItem } from "./types.js";

const MAX_FIT_ROUNDS = 16;

function fits(input: ItemInput): boolean {
  return contentBytes(encodeItem(input)) <= MAX_CONTENT_BYTES;
}

// Slices on code points, so an astral character is never split into a lone surrogate.
function shrink(value: string | undefined, round: number): string | undefined {
  if (value === undefined) return undefined;
  const points = Array.from(value);
  return `${points.slice(0, Math.floor(points.length / 2 ** round)).join("")}…`;
}

/** Halves `inputPreview` and `text` until the encoded content fits, marking the item truncated. */
export function fitItem(input: ItemInput): ItemInput {
  if (fits(input)) return input;
  for (let round = 1; round <= MAX_FIT_ROUNDS; round += 1) {
    const cut = { ...input, input_preview: shrink(input.input_preview, round), text: shrink(input.text, round), truncated: true };
    if (fits(cut)) return cut;
  }
  return { ...input, input_preview: undefined, text: undefined, truncated: true };
}

function redactFields(item: QueueItem): { inputPreview?: string; text?: string; redacted: boolean } {
  if (item.kind === "approval_request" && item.inputPreview !== undefined) {
    const { text, redacted } = redactPreview(item.inputPreview);
    return { inputPreview: text, text: item.text, redacted };
  }
  if (item.kind === "endorse_request" && item.text !== undefined) {
    const { text, redacted } = redactPreview(item.text);
    return { inputPreview: item.inputPreview, text, redacted };
  }
  return { inputPreview: item.inputPreview, text: item.text, redacted: false };
}

/** Redacts before fitting, so a cut never strands the tail of a secret the patterns no longer see whole. */
export function toItemInput(item: QueueItem): ItemInput {
  const { inputPreview, text, redacted } = redactFields(item);
  return fitItem({
    kind: item.kind,
    machine: item.machine,
    session: item.session,
    agent_id: item.agentId,
    msg_id: item.id,
    at: item.at,
    tool_name: item.toolName,
    input_preview: inputPreview,
    recipient: item.recipient,
    text,
    truncated: false,
    redacted,
  });
}

/** A /sync filter that returns only the queue room's timeline, with no presence, receipts or account data. */
export function syncFilter(roomId: string): Record<string, unknown> {
  const none = { types: [] as string[] };
  return {
    presence: none,
    account_data: none,
    room: { rooms: [roomId], timeline: { limit: 50 }, state: none, ephemeral: none, account_data: none },
  };
}
