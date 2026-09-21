import type { EventBase } from "./events.js";

/**
 * Bumped whenever a classification rule below changes, so a consumer can tell
 * rows extracted under an older rule set apart and re-index them.
 */
export const EXTRACT_VERSION = 1;

/** Coarse bucket for a tool name, so cost can be attributed without a per-tool table. */
export type ToolFamily =
  | "none"
  | "mcp_agentchat"
  | "mcp_other"
  | "fs_read"
  | "fs_write"
  | "bash"
  | "ask_user"
  | "subagent"
  | "web"
  | "scheduling"
  | "skill_toolsearch"
  | "other_tool";

/** What woke the session for one inbound record. One value per user-role or delivering record. */
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

/** Where the characters in one context block came from. */
export type ContextSource =
  | "tool_result"
  | "human"
  | "channel"
  | "assistant_text"
  | "assistant_thinking"
  | "assistant_tool_input"
  | "attachment"
  | "skill_listing"
  | "system_reminder"
  | "compaction_summary"
  | "image";

/** A recognisable act read from a single `tool_use` block. */
export type SignalKind =
  | "status_report"
  | "pr_create"
  | "commit"
  | "push"
  | "task_wrap"
  | "task_done"
  | "doc_written"
  | "agent_spawn"
  | "chat_send";

/** Audit events locate themselves within a line, not just at it; 0 for whole-line events. */
export interface AuditEventBase extends EventBase {
  blockIndex: number;
}

export type AuditEvent =
  | (AuditEventBase & {
      kind: "request";
      requestId: string;
      messageId: string | null;
      model: string;
      inputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      cacheCreation5mTokens: number;
      cacheCreation1hTokens: number;
      outputTokens: number;
      thinkingTokens: number;
      serviceTier: string | null;
      isSidechain: boolean;
    })
  | (AuditEventBase & { kind: "tool_call"; toolUseId: string; name: string; family: ToolFamily; mcpServer: string | null; inputChars: number })
  | (AuditEventBase & {
      kind: "inbound";
      cause: WakeCause;
      delivery: "turn_start" | "mid_loop" | "tool_result";
      detail: string | null;
      originServer: string | null;
      fromName: string | null;
      msgId: string | null;
      toolUseId: string | null;
      isError: boolean;
      contentHash: string;
      chars: number;
    })
  | (AuditEventBase & { kind: "context_block"; source: ContextSource; toolUseId: string | null; attachmentType: string | null; chars: number; isMedia: boolean })
  | (AuditEventBase & {
      kind: "compaction";
      trigger: "manual" | "auto" | null;
      preTokens: number | null;
      postTokens: number | null;
      droppedTokens: number | null;
      durationMs: number | null;
    })
  | (AuditEventBase & { kind: "queue_op"; operation: QueueOperation; contentHash: string | null; originServer: string | null })
  | (AuditEventBase & { kind: "signal"; signal: SignalKind; detail: string | null; toolUseId: string | null })
  | (AuditEventBase & { kind: "cost_state"; totalCostUsd: number; modelUsageJson: string });

export type QueueOperation = "enqueue" | "dequeue" | "remove" | "popAll";

export type AuditEventKind = AuditEvent["kind"];
