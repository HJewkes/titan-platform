import { hasMarker, INJECTED_MARKERS, type Inbound, type InjectedMarkerName, type WakeCause } from "@titan-design/session-read";

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

/** A line nobody typed: an injected cause, or a headless `sdk` prompt unless the caller keeps those. */
export function isUntypedPrompt(inbound: Pick<Inbound, "cause" | "promptSource">, indexSdkPrompts = false): boolean {
  return isInjectedCause(inbound.cause) || (!indexSdkPrompts && inbound.promptSource === "sdk");
}

/** session-read's closed markers (system reminders, channel messages, task notifications) plus host echoes it does not list. */
const CUT_TAGS = [
  ...Object.values(INJECTED_MARKERS).flatMap(m => (m.close ? [m.close.slice(2, -1)] : [])),
  "user-prompt-submit-hook", "command-name", "command-message", "local-command-caveat",
  "local-command-stdout", "local-command-stderr", "bash-stdout", "bash-stderr",
].join("|");
const CUT_OPEN = new RegExp(`<(${CUT_TAGS})(?=[\\s>])[^>]*>`, "g");
const LINE_END_OR_BLOCK = new RegExp(`^[ \\t]*(?:\\r?\\n|$|<(?:${CUT_TAGS})(?=[\\s>]))`);

/** An opening tag counts only at the start of a line or straight after a block already cut, so prose that mentions a tag stays. */
function opensBlock(text: string, at: number, keptFrom: number): boolean {
  const lead = text.slice(Math.max(text.lastIndexOf("\n", at - 1) + 1, keptFrom), at);
  return lead.trim() === "";
}

/** The index just past the close that balances this open tag, counting nested same-name tags; null when it never closes. */
function balancedClose(text: string, tag: string, from: number): number | null {
  const tags = new RegExp(`<(/?)${tag}(?=[\\s>])[^>]*>`, "g");
  tags.lastIndex = from;
  let depth = 1;
  for (let m = tags.exec(text); m; m = tags.exec(text)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return tags.lastIndex;
  }
  return null;
}

/** A block ends a line when only whitespace or another cut block follows its close on that line. */
function closesLine(text: string, at: number): boolean {
  return LINE_END_OR_BLOCK.test(text.slice(at));
}

function cutBlocks(text: string): string {
  let kept = "";
  let keptFrom = 0;
  CUT_OPEN.lastIndex = 0;
  for (let open = CUT_OPEN.exec(text); open; open = CUT_OPEN.exec(text)) {
    if (!opensBlock(text, open.index, keptFrom)) continue;
    const end = balancedClose(text, open[1]!, CUT_OPEN.lastIndex);
    if (end === null || !closesLine(text, end)) continue;
    kept += text.slice(keptFrom, open.index);
    keptFrom = end;
    CUT_OPEN.lastIndex = end;
  }
  return kept + text.slice(keptFrom);
}

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
];

function isWholeTurnInjected(text: string): boolean {
  const trimmed = text.trim();
  return WHOLE_TURN_MARKERS.some(name => hasMarker(trimmed, name)) || SPAWN_BRIEF_FRAMING.some(re => re.test(trimmed));
}

/** Prompt text with every injected block removed; empty when nothing the human wrote is left. */
export function stripInjected(text: string): string {
  let kept = cutBlocks(text);
  for (const re of [INTERRUPTION, ...HUMAN_WRAPPERS]) kept = kept.replace(re, "");
  if (isWholeTurnInjected(kept)) return "";
  return kept.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
