/**
 * Message a live agent through `agent-chat debug send`: the broker delivers the
 * text as one channel message, which starts a turn in an idle session. Use it
 * for a live agent; `resumeAgent` is for an ended one. The CLI connects
 * unregistered, so the broker delivers the text from the human seat; a `source`
 * labels it as that wake source, without human provenance. Like
 * `resumeAgent`, the text is in argv, where `ps` shows it.
 */

import { refusal, runAgentChatAsync, type AgentRow } from "./agents.js";
import { DispatchError, PEER_NAME_PATTERN } from "./dispatch.js";

/** Mirrors agent-chat's `WAKE_SOURCES`: the label a recipient sees instead of the owner typing. */
export type WakeSource = "watchdog" | "shepherd" | "console";

export interface MessageOptions {
  /** Sent as `--source`, so the message arrives labelled `wake_source=<source>` rather than as the owner's words. */
  source?: WakeSource;
}

/** `--` ends the options, so a text that begins with a dash stays one operand; `--source` must come before it. */
export function buildMessageArgs(name: string, text: string, options: MessageOptions = {}): string[] {
  const source = options.source === undefined ? [] : ["--source", options.source];
  return ["debug", "send", ...source, "--", name, text];
}

/**
 * Whether `messageAgent` can reach the agent a roster row names. An unregistered sender reaches only a connected
 * session, so a `detached` row (not exited, but nothing connected) is as unreachable as an `exited` one.
 */
export function receivesMessages(row: Pick<AgentRow, "presence">): boolean {
  return row.presence === "live";
}

/** Deliver `text` to the live agent `name`; rejects with `DispatchError` when the broker has no live session by that name. */
export async function messageAgent(
  agentChatBinPath: string,
  name: string,
  text: string,
  timeoutMs: number,
  options: MessageOptions = {},
): Promise<void> {
  if (!PEER_NAME_PATTERN.test(name)) {
    throw new DispatchError(`invalid peer name: '${name}'`);
  }
  if (text.trim() === "") {
    throw new DispatchError("a message needs non-empty text");
  }
  const result = await runAgentChatAsync(agentChatBinPath, buildMessageArgs(name, text, options), timeoutMs);
  if (result.status !== 0) throw refusal("send", result);
}
