/**
 * What woke the session, read off one arriving record. The transcript records
 * what arrived, not what a human did: a `<task-notification>` block is a
 * background task reporting in, not the human typing (wf_analyze.py:423-441).
 */

import { createHash } from "node:crypto";
import { findInjectedMarker, hasMarker, parseChannelTag, type ChannelTag } from "./injected-markers.js";
import { asObject, blocks, str, toolResultText, type Json } from "./text.js";

export type WakeCause =
  | "compaction"
  | "ask_user_answer"
  | "tool_result"
  | "channel_message"
  | "channel_system"
  | "task_notification"
  | "scheduled_wakeup"
  | "usage_limit_resume"
  | "harness_resume"
  | "local_command"
  | "image_meta"
  | "hook_or_reminder"
  | "human_typed";

export type InboundDelivery = "turn_start" | "mid_loop" | "tool_result";

export interface Inbound {
  readonly cause: WakeCause;
  readonly delivery: InboundDelivery;
  /** A short structural token (task id, command name, marker name), never message prose. */
  readonly detail: string | null;
  readonly originServer: string | null;
  readonly fromName: string | null;
  readonly msgId: string | null;
  readonly toolUseId: string | null;
  readonly isError: boolean;
  readonly contentHash: string;
  readonly chars: number;
}

/** Rollup pairs a queued arrival with its delivery by this hash, so both sides must agree. */
export const HASH_PREFIX_CHARS = 512;

export function contentHash(text: string): string {
  return createHash("sha1").update(text.slice(0, HASH_PREFIX_CHARS), "utf8").digest("hex");
}

const SCHEDULED_WAKEUP = /^#\s*Autonomous loop check\b/;
const TASK_ID = /<task-id>([^<]+)<\/task-id>/;
const COMMAND_NAME = /<command-name>([^<]+)<\/command-name>/;

interface Result {
  readonly toolUseId: string | null;
  readonly isError: boolean;
  readonly present: boolean;
}

export function classifyInbound(record: Json): Inbound {
  const queued = queuedCommand(record);
  const text = recordText(record, queued);
  const result = toolResult(record, queued);
  const channel = parseChannelTag(text);
  const cause = causeOf(record, queued, text, result, channel);
  return {
    cause,
    delivery: queued ? "mid_loop" : result.present ? "tool_result" : "turn_start",
    detail: detailOf(cause, text),
    originServer: channel?.source ?? originServer(queued),
    fromName: channel?.from ?? null,
    msgId: channel?.msgId ?? null,
    toolUseId: result.toolUseId,
    isError: result.isError,
    contentHash: contentHash(text),
    chars: text.length,
  };
}

function causeOf(record: Json, queued: Json | null, text: string, result: Result, channel: ChannelTag | null): WakeCause {
  if (record.isCompactSummary === true) return "compaction";
  if (isAskUserAnswer(record)) return "ask_user_answer";
  if (result.present) return "tool_result";
  if (channel) return channel.isSystem ? "channel_system" : "channel_message";
  if (hasMarker(text, "task_notification")) return "task_notification";
  if (isMeta(record, queued)) return metaCause(text);
  return "human_typed";
}

function metaCause(text: string): WakeCause {
  if (hasMarker(text, "loop_wakeup") || SCHEDULED_WAKEUP.test(text.trimStart())) return "scheduled_wakeup";
  const head = text.slice(0, 400).toLowerCase();
  if (head.includes("usage limit")) return "usage_limit_resume";
  if (text.slice(0, 400).includes("Continue from where you left off")) return "harness_resume";
  if (hasMarker(text, "local_command")) return "local_command";
  if (hasMarker(text, "image_meta")) return "image_meta";
  return "hook_or_reminder";
}

function detailOf(cause: WakeCause, text: string): string | null {
  if (cause === "task_notification") return TASK_ID.exec(text)?.[1] ?? null;
  if (cause === "local_command") return COMMAND_NAME.exec(text)?.[1] ?? null;
  if (cause === "hook_or_reminder") return findInjectedMarker(text);
  return null;
}

/**
 * An `AskUserQuestion` result is the human answering, not a tool reporting.
 * The line alone identifies it: `toolUseResult` carries `questions` and an
 * `answers` map keyed by question text.
 */
function isAskUserAnswer(record: Json): boolean {
  const result = asObject(record.toolUseResult);
  if (!result) return false;
  return asObject(result.answers) !== null && Array.isArray(result.questions);
}

function queuedCommand(record: Json): Json | null {
  if (record.type !== "attachment") return null;
  const attachment = asObject(record.attachment);
  return attachment?.type === "queued_command" ? attachment : null;
}

function isMeta(record: Json, queued: Json | null): boolean {
  return record.isMeta === true || queued?.isMeta === true;
}

function originServer(queued: Json | null): string | null {
  const origin = asObject(queued?.origin);
  return origin?.kind === "channel" ? str(origin, "server") : null;
}

function toolResult(record: Json, queued: Json | null): Result {
  if (queued) return { toolUseId: null, isError: false, present: false };
  const block = blocks(asObject(record.message)).find((b) => b.type === "tool_result");
  return {
    toolUseId: str(block ?? null, "tool_use_id"),
    isError: block?.is_error === true,
    present: record.toolUseResult != null || block !== undefined,
  };
}

function recordText(record: Json, queued: Json | null): string {
  if (queued) return str(queued, "prompt") ?? "";
  const content = asObject(record.message)?.content;
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of blocks(asObject(record.message))) {
    if (block.type === "text") parts.push(str(block, "text") ?? "");
    else if (block.type === "tool_result") parts.push(toolResultText(block.content));
  }
  return parts.filter(Boolean).join("\n");
}
