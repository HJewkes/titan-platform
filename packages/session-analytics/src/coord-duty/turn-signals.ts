import { parseChannelTag } from "@titan-design/session-read";
import type { ToolUse } from "./transcript.js";

export type Trigger =
  | "local-cmd"
  | "cron-heartbeat"
  | "boot"
  | "bg-task-notification"
  | "agent-chat system msg"
  | "peer-seat msg"
  | "operator/ram relay"
  | "own-agent report"
  | "one-shot-timer"
  | "owner/direct";

/** The prompt prefix the trigger rules read, as the tick audit did. */
const TRIGGER_SCAN_CHARS = 400;
const BOOT_PREFIX = /^(Run the autonomy charter|Teleport:|This session is being continued)/;
const BOOT_PHRASE = /you are (now )?(resumed|on the MAIN broker)|I restarted you/;
const BOOT_PHRASE_CHARS = 200;
const SEAT_SUFFIX = "-coord";

/**
 * What woke the turn: the rebuilt tick-audit rules, first match wins. `ops` are the operator
 * sessions; they relay over the channel or type straight into the seat's pane.
 */
export function triggerOf(text: string, origin: string | null, ops: readonly string[]): Trigger {
  const head = text.slice(0, TRIGGER_SCAN_CHARS);
  if (head.startsWith("<local-command") || head.startsWith("<command-name")) return "local-cmd";
  if (head.startsWith("Heartbeat tick")) return "cron-heartbeat";
  if (BOOT_PREFIX.test(head) || BOOT_PHRASE.test(head.slice(0, BOOT_PHRASE_CHARS))) return "boot";
  if (head.startsWith("<task-notification")) return "bg-task-notification";
  if (head.startsWith("<channel")) return channelTrigger(head, ops);
  if (ops.some((op) => head.startsWith(op))) return "operator/ram relay";
  if (origin === "scheduled") return "one-shot-timer";
  return "owner/direct";
}

function channelTrigger(head: string, ops: readonly string[]): Trigger {
  const tag = parseChannelTag(head);
  if (tag?.isSystem) return "agent-chat system msg";
  const from = tag?.from ?? "";
  if (from.endsWith(SEAT_SUFFIX)) return "peer-seat msg";
  if (ops.includes(from)) return "operator/ram relay";
  return "own-agent report";
}

/** Turn outcomes in priority order: a turn's outcome is the first one any of its tools hits. */
const OUTCOMES = ["dispatch", "merge", "retire", "task", "peer-reply", "file-write", "teleport"] as const;
export type Outcome = (typeof OUTCOMES)[number] | "NO-OP";

const OUTCOME_TESTS: Record<(typeof OUTCOMES)[number], (tool: ToolUse, command: string) => boolean> = {
  dispatch: (tool, command) => endsWithAny(tool.name, ["agent_spawn", "agent_resume"]) || /agent-chat agent (spawn|resume)/.test(command),
  merge: (_tool, command) => /seat-merge |bin\/merge|gh pr merge/.test(command),
  retire: (_tool, command) => /agent-chat agent (retire|park)|worktree remove/.test(command),
  task: (_tool, command) => /active-work task (add|edit|done)/.test(command),
  "peer-reply": (tool) => endsWithAny(tool.name, ["chat_send", "chat_broadcast", "chat_endorse"]),
  "file-write": (tool, command) => tool.name === "Write" || tool.name === "Edit" || />>\s*"?\S*logs\/|sed -i/.test(command),
  teleport: (tool) => tool.name.endsWith("agent_teleport"),
};

/** A turn that only reads, polls or writes text is NO-OP; any send counts as work, so NO-OP is a lower bound. */
export function outcomeOf(tools: readonly ToolUse[]): Outcome {
  const hit = (outcome: (typeof OUTCOMES)[number]) => tools.some((tool) => OUTCOME_TESTS[outcome](tool, bashCommand(tool)));
  return OUTCOMES.find(hit) ?? "NO-OP";
}

export function bashCommand(tool: ToolUse): string {
  const command = tool.input.command;
  return tool.name === "Bash" && typeof command === "string" ? command : "";
}

function endsWithAny(name: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => name.endsWith(suffix));
}
