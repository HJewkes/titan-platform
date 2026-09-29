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
 */

export class ResumeError extends Error {}

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
