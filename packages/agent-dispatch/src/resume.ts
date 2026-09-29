/**
 * Resume an ENDED agent's Claude Code session with one more message: R-59's
 * `resumeWithMessage`, which starts a fresh `claude` process against the same
 * session id. Ported from relay's `daemon/src/session.ts`.
 *
 * The message text is never interpolated into a shell or a flag: this returns
 * an argv array, `execSafe` runs it with `shell: false`, and the words stay one
 * opaque argument. Unlike a spawn brief, the message IS in argv and so is
 * visible via `ps`; see dispatch.ts's M8 note for that cost.
 *
 * Resuming a LIVE agent starts a second process on a transcript another process
 * is still writing, so callers decide liveness first; this module does not.
 *
 * `resumeAgent` is the broker-tracked form: it asks agent-chat to resume the
 * agent by name, so the roster sees the resumed session. Its message is in argv
 * too, until agent-chat takes it on stdin.
 */

import { refusal, runAgentChat } from "./agents.js";
import { DispatchError, PEER_NAME_PATTERN } from "./dispatch.js";

export class ResumeError extends Error {}

export interface ResumeAgentResult {
  name: string;
  /** agent-chat's report, verbatim: the transcript verdict and any warnings. */
  lines: string[];
}

/**
 * R-59's primitive, inlined as a shape assertion rather than imported: this
 * package takes no dependency on agent-chat's source tree (dispatch.ts's
 * header: the supported programmatic surface is the CLI). Kept byte-identical
 * to `resumeWithMessage` — `-p` is a BOOLEAN there, so the message is a
 * positional prompt, and the `--` guards a message that begins with a dash.
 */
export function resumeArgs(sessionId: string, message: string): string[] {
  if (sessionId.trim() === "") {
    throw new ResumeError("resuming needs a session id");
  }
  if (message.trim() === "") {
    throw new ResumeError("resuming needs a non-empty message");
  }
  return ["-p", "--", message, "--resume", sessionId];
}

export function buildResumeAgentArgs(name: string, message: string): string[] {
  return ["agent", "resume", name, "--message", message];
}

/** Resume an ended agent on its own conversation, with `message` as its next turn. */
export function resumeAgent(
  agentChatBinPath: string,
  name: string,
  message: string,
  timeoutMs: number,
): ResumeAgentResult {
  if (!PEER_NAME_PATTERN.test(name)) {
    throw new DispatchError(`invalid peer name: '${name}'`);
  }
  if (message.trim() === "") {
    throw new DispatchError("resuming needs a non-empty message");
  }
  const args = buildResumeAgentArgs(name, message);
  const result = runAgentChat(agentChatBinPath, args, timeoutMs);
  if (result.status !== 0) throw refusal("agent resume", result);
  const lines = result.stdout.split("\n").map((line) => line.trim());
  return { name, lines: lines.filter((line) => line !== "") };
}
