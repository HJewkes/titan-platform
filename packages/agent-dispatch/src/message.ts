/**
 * Message a live agent through `agent-chat debug send`: the broker delivers the
 * text as one channel message, which starts a turn in an idle session. Use it
 * for a live agent; `resumeAgent` is for an ended one. The CLI connects
 * unregistered, so the broker delivers the text from the human seat. Like
 * `resumeAgent`, the text is in argv, where `ps` shows it.
 */

import { refusal, runAgentChat } from "./agents.js";
import { DispatchError, PEER_NAME_PATTERN } from "./dispatch.js";

/** `--` ends the options, so a text that begins with a dash stays one operand. */
export function buildMessageArgs(name: string, text: string): string[] {
  return ["debug", "send", "--", name, text];
}

/** Deliver `text` to the live agent `name`; throws `DispatchError` when the broker has no live session by that name. */
export function messageAgent(
  agentChatBinPath: string,
  name: string,
  text: string,
  timeoutMs: number,
): void {
  if (!PEER_NAME_PATTERN.test(name)) {
    throw new DispatchError(`invalid peer name: '${name}'`);
  }
  if (text.trim() === "") {
    throw new DispatchError("a message needs non-empty text");
  }
  const result = runAgentChat(agentChatBinPath, buildMessageArgs(name, text), timeoutMs);
  if (result.status !== 0) throw refusal("send", result);
}
