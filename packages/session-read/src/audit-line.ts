import type { QueueOperation } from "./audit-events.js";
import type { LineContext, LineReader } from "./line-reader.js";
import { asObject, int, str, thinkingTokens, type Json } from "./text.js";
import { toolFamily } from "./tool-family.js";
import { contentHash } from "./wake-cause.js";

const CHANNEL_SOURCE = /<channel\s+source="([^"]+)"/;
const QUEUE_OPERATIONS = new Set<string>(["enqueue", "dequeue", "remove", "popAll"]);
const COMPACTION_TRIGGERS = new Set<string>(["manual", "auto"]);

/** One `request` per assistant line; the store dedupes on `requestId` so a split response counts once. */
export function emitRequest(reader: LineReader, ctx: LineContext, message: Json | null): void {
  const usage = asObject(message?.usage);
  const model = str(message, "model");
  const messageId = str(message, "id");
  const requestId = str(ctx.line, "requestId") ?? messageId;
  if (!usage || !model || !requestId) return;
  const cacheCreation = asObject(usage.cache_creation);
  const outputTokens = int(usage, "output_tokens");
  reader.emit({
    ...reader.base(ctx),
    kind: "request",
    blockIndex: 0,
    requestId,
    messageId,
    model,
    inputTokens: int(usage, "input_tokens"),
    cacheReadTokens: int(usage, "cache_read_input_tokens"),
    cacheCreationTokens: int(usage, "cache_creation_input_tokens"),
    cacheCreation5mTokens: int(cacheCreation, "ephemeral_5m_input_tokens"),
    cacheCreation1hTokens: int(cacheCreation, "ephemeral_1h_input_tokens"),
    outputTokens,
    thinkingTokens: thinkingTokens(message, outputTokens),
    serviceTier: str(usage, "service_tier"),
    isSidechain: ctx.line.isSidechain === true,
  });
}

/** `blockIndex` is the position in the line's content, so rollup can order calls within a turn. */
export function emitToolCalls(reader: LineReader, ctx: LineContext, content: Json[]): void {
  content.forEach((block, blockIndex) => {
    const toolUseId = str(block, "id");
    const name = str(block, "name");
    if (block.type !== "tool_use" || !toolUseId || !name) return;
    const { family, mcpServer } = toolFamily(name);
    reader.emit({ ...reader.base(ctx), kind: "tool_call", blockIndex, toolUseId, name, family, mcpServer, inputChars: JSON.stringify(block.input ?? null).length });
  });
}

export function emitCompaction(reader: LineReader, ctx: LineContext): void {
  const meta = asObject(ctx.line.compactMetadata);
  const trigger = str(meta, "trigger");
  reader.emit({
    ...reader.base(ctx),
    kind: "compaction",
    blockIndex: 0,
    trigger: trigger && COMPACTION_TRIGGERS.has(trigger) ? (trigger as "manual" | "auto") : null,
    preTokens: numberOrNull(meta, "preTokens"),
    postTokens: numberOrNull(meta, "postTokens"),
    droppedTokens: numberOrNull(meta, "cumulativeDroppedTokens"),
    durationMs: numberOrNull(meta, "durationMs"),
  });
}

/** Arrival of a message that landed while the session was busy; rollup pairs it with the delivery. */
export function emitQueueOp(reader: LineReader, ctx: LineContext): void {
  const operation = str(ctx.line, "operation");
  if (!operation || !QUEUE_OPERATIONS.has(operation)) return;
  const content = str(ctx.line, "content");
  reader.emit({
    ...reader.base(ctx),
    kind: "queue_op",
    blockIndex: 0,
    operation: operation as QueueOperation,
    contentHash: content ? contentHash(content) : null,
    originServer: content ? (CHANNEL_SOURCE.exec(content)?.[1] ?? null) : null,
  });
}

export function emitCostState(reader: LineReader, ctx: LineContext): void {
  reader.emit({
    ...reader.base(ctx),
    kind: "cost_state",
    blockIndex: 0,
    totalCostUsd: int(ctx.line, "totalCostUSD"),
    modelUsageJson: JSON.stringify(asObject(ctx.line.modelUsage) ?? {}),
  });
}

function numberOrNull(source: Json | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
