/** Wake triggers in report column order; each pushed message gets exactly one. */
export const TRIGGERS = ["digest", "pr-notice", "task-note", "lifecycle", "broker", "host", "cron", "peer", "owner", "sdk", "other"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export interface Wake {
  at: string;
  trigger: Trigger;
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const rec = (value: unknown): Rec => (isRec(value) ? value : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block === "string" ? block : str(rec(block).text))).join("\n");
}

/**
 * Host processes send with the `agent-chat` CLI, which the broker labels `from="human"`, so a channel message
 * from "human" is a host job (Shepherd, deploy watch, console), never the owner typing.
 */
function channelTrigger(text: string): Trigger {
  const from = /<channel\b[^>]*\bfrom="([^"]*)"/.exec(text)?.[1] ?? "";
  const body = text.slice(text.indexOf(">") + 1).trimStart();
  if (from === "human") {
    if (body.startsWith("Shepherd digest for")) return "digest";
    return body.startsWith("Shepherd:") ? "pr-notice" : "host";
  }
  if (from !== "agent-chat") return "peer";
  if (body.startsWith("Lifecycle:")) return "lifecycle";
  return /\breports? from peers\b/.test(body) ? "peer" : "broker";
}

function byText(text: string): Trigger | null {
  const start = text.trimStart();
  if (start.startsWith("<channel")) return channelTrigger(start);
  if (start.startsWith("<task-notification>")) return "task-note";
  return null;
}

function byOrigin(kind: string, turnOrigin: string, text: string): Trigger | null {
  if (kind === "channel" || turnOrigin === "peer") return byText(text) ?? "peer";
  if (kind === "task-notification" || turnOrigin === "task_notification") return "task-note";
  if (turnOrigin === "scheduled") return "cron";
  if (kind === "human" || turnOrigin === "human") return "owner";
  if (turnOrigin === "sdk") return "sdk";
  return null;
}

/**
 * A user record that starts or joins a turn: tool results, companion text (loop summaries, image notes) and
 * meta records with no origin (skill bodies) are not wakes. Older transcripts without origin fields fall back to the tags.
 */
export function userWake(j: Rec): Trigger | null {
  const content = rec(j.message).content;
  if (j.turnCompanion || (Array.isArray(content) && content.some((b) => rec(b).type === "tool_result"))) return null;
  const text = textOf(content);
  if (j.scheduledTaskId) return "cron";
  const hinted = byOrigin(str(rec(j.origin).kind), str(j.turnOrigin), text);
  if (hinted) return hinted;
  if (j.turnOrigin || j.origin) return "other";
  return byText(text) ?? (j.isMeta || !text.trim() ? null : "owner");
}

/** A message that arrived mid-turn and rode along as a `queued_command` attachment instead of its own user record. */
export function queuedWake(a: Rec): Trigger {
  const text = textOf(a.prompt);
  return byOrigin(str(rec(a.origin).kind), "", text) ?? byText(text) ?? "other";
}
