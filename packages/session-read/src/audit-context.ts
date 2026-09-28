import type { ContextSource } from "./audit-events.js";
import type { LineContext, LineReader } from "./line-reader.js";
import { asObject, blocks, str, type Json } from "./text.js";
import type { WakeCause } from "./wake-cause.js";

/** Below this, an attachment is a fixed harness note (`output_style`, `total_tokens_reminder`) repeated every turn. */
export const MIN_ATTACHMENT_CHARS = 256;

interface Measured {
  readonly chars: number;
  readonly isMedia: boolean;
}

interface BlockRow extends Measured {
  readonly source: ContextSource;
  readonly blockIndex: number;
  readonly toolUseId: string | null;
  readonly attachmentType: string | null;
}

/** The text of a user record is labelled by what delivered it, since the harness injects most of it. */
export function sourceForCause(cause: WakeCause | null): ContextSource {
  if (cause === "compaction") return "compaction_summary";
  if (cause === "channel_message" || cause === "channel_system") return "channel";
  if (cause === "human_typed") return "human";
  return cause === null ? "attachment" : "system_reminder";
}

/** One row for the record's text, and one per `tool_result` or image block. */
export function emitContextBlocks(reader: LineReader, ctx: LineContext, cause: WakeCause): void {
  const message = asObject(ctx.line.message);
  if (typeof message?.content === "string") {
    return emitRow(reader, ctx, { ...row(sourceForCause(cause), 0), chars: message.content.length, isMedia: false });
  }
  const content = blocks(message);
  const textIndex = content.findIndex((b) => b.type === "text");
  const textChars = content.reduce((sum, b) => sum + (b.type === "text" ? (str(b, "text") ?? "").length : 0), 0);
  if (textIndex >= 0) emitRow(reader, ctx, { ...row(sourceForCause(cause), textIndex), chars: textChars, isMedia: false });
  content.forEach((block, blockIndex) => {
    if (block.type === "tool_result") emitRow(reader, ctx, { ...row("tool_result", blockIndex, str(block, "tool_use_id")), ...measureContent(block.content) });
    else if (block.type === "image") emitRow(reader, ctx, { ...row("image", blockIndex), ...measureContent([block]) });
  });
}

/** Per block, so thinking, prose and tool input stay separable with their own locators. */
export function emitAssistantContextBlocks(reader: LineReader, ctx: LineContext, content: Json[]): void {
  content.forEach((block, blockIndex) => {
    if (block.type === "text") emitRow(reader, ctx, { ...row("assistant_text", blockIndex), chars: (str(block, "text") ?? "").length, isMedia: false });
    else if (block.type === "thinking") emitRow(reader, ctx, { ...row("assistant_thinking", blockIndex), chars: (str(block, "thinking") ?? "").length, isMedia: false });
    else if (block.type === "tool_use") {
      emitRow(reader, ctx, { ...row("assistant_tool_input", blockIndex, str(block, "id")), chars: JSON.stringify(block.input ?? null).length, isMedia: false });
    }
  });
}

/** `cause` is set only for a `queued_command`, whose prompt is a delivered message rather than a harness note. */
export function emitAttachmentContextBlock(reader: LineReader, ctx: LineContext, attachment: Json | null, cause: WakeCause | null): void {
  const chars = stringChars(attachment);
  if (!attachment || chars < MIN_ATTACHMENT_CHARS) return;
  const attachmentType = str(attachment, "type");
  const source = attachmentType === "skill_listing" ? "skill_listing" : sourceForCause(cause);
  emitRow(reader, ctx, { ...row(source, 0, str(attachment, "toolUseID")), attachmentType, chars, isMedia: false });
}

function row(source: ContextSource, blockIndex: number, toolUseId: string | null = null): Omit<BlockRow, keyof Measured> {
  return { source, blockIndex, toolUseId, attachmentType: null };
}

function emitRow(reader: LineReader, ctx: LineContext, block: BlockRow): void {
  reader.emit({ ...reader.base(ctx), kind: "context_block", ...block });
}

/** A `tool_result` content is a bare string or text and image blocks; an image counts its base64 length. */
function measureContent(content: unknown): Measured {
  if (typeof content === "string") return { chars: content.length, isMedia: false };
  let chars = 0;
  let isMedia = false;
  for (const block of Array.isArray(content) ? content.map(asObject) : []) {
    if (block?.type === "image") {
      isMedia = true;
      chars += (str(asObject(block.source), "data") ?? "").length;
    } else chars += (str(block, "text") ?? "").length;
  }
  return { chars, isMedia };
}

function stringChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + stringChars(item), 0);
  const object = asObject(value);
  return object ? Object.values(object).reduce((sum: number, item) => sum + stringChars(item), 0) : 0;
}
