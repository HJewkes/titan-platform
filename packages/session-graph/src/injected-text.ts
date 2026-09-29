import { hasMarker, INJECTED_MARKERS, type InjectedMarkerName, type WakeCause } from "@titan-design/session-read";

/**
 * TP-108: what the harness, hooks and agent-chat put into a `user` record, cut out
 * of the prompt text that full-text search and the miner see. The human's own
 * words stay. The marker list is documented in the README under "Injected context".
 */

/** Whole-line causes: session-read's inbound classifier already knows nobody typed these. */
const INJECTED_CAUSES: ReadonlySet<WakeCause> = new Set<WakeCause>([
  "compaction", "channel_message", "channel_system", "task_notification", "scheduled_wakeup",
  "usage_limit_resume", "harness_resume", "local_command", "image_meta", "hook_or_reminder",
]);

export function isInjectedCause(cause: WakeCause): boolean {
  return INJECTED_CAUSES.has(cause);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tagBlock = (tag: string) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g");

/** session-read's closed markers, cut wherever they sit: system reminders, channel messages, task notifications. */
const SHARED_BLOCKS = Object.values(INJECTED_MARKERS)
  .filter(m => m.close !== null)
  .map(m => new RegExp(`${m.open.source}[\\s\\S]*?${escape(m.close ?? "")}`, "g"));

/** Host echoes session-read does not list: hook output, slash-command framing, command and shell output. */
const HOST_BLOCKS = [
  "user-prompt-submit-hook", "command-name", "command-message", "local-command-caveat",
  "local-command-stdout", "local-command-stderr", "bash-stdout", "bash-stderr",
].map(tagBlock);

const INTERRUPTION = /\[Request interrupted by user[^\]\n]*\]/g;

/** Wrappers around words the human did type: slash-command arguments and a `!` shell command. */
const HUMAN_WRAPPERS = ["command-args", "bash-input"].map(tag => new RegExp(`</?${tag}>`, "g"));

/** Unclosed markers in session-read's list: when one heads the text, the whole turn is injected. */
const WHOLE_TURN_MARKERS = (Object.keys(INJECTED_MARKERS) as InjectedMarkerName[])
  .filter(name => INJECTED_MARKERS[name].close === null);

/**
 * agent-chat puts no tag around a spawn brief, so a brief is known by the framing it
 * writes itself: the orientation header (session-read's `spawn_brief`), a predecessor
 * section, and the isolation note appended last. A coordinator wrote the rest.
 */
const SPAWN_BRIEF_FRAMING = [
  /^# Predecessor: .*\n\nYou are taking over from /,
  /Commit your work there; nothing outside it is yours to change\.\s*$/,
  /You may be sharing it with other agents, so stay inside the paths you were given\.\s*$/,
  /^--- File Ownership ---$/m,
];

function isWholeTurnInjected(text: string): boolean {
  const trimmed = text.trim();
  return WHOLE_TURN_MARKERS.some(name => hasMarker(trimmed, name)) || SPAWN_BRIEF_FRAMING.some(re => re.test(trimmed));
}

/** Prompt text with every injected block removed; empty when nothing the human wrote is left. */
export function stripInjected(text: string): string {
  let kept = text;
  for (const re of [...SHARED_BLOCKS, ...HOST_BLOCKS, INTERRUPTION, ...HUMAN_WRAPPERS]) kept = kept.replace(re, "");
  if (isWholeTurnInjected(kept)) return "";
  return kept.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
