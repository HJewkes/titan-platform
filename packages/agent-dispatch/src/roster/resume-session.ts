import type { AgentIdentity } from "./types.js";
import type { TranscriptVerdict } from "./predecessor.js";

/**
 * CC-126: bringing an agent back WITH its conversation. The pure half: the decisions a
 * resume makes from an identity, a transcript verdict and a directory check the product supplies.
 * Finding the transcript, re-creating a removed worktree and launching stay with the product.
 *
 * Two routes, because retire is absorbing. An agent that finished or detached still holds its
 * identity and name, so a resume relaunches that identity. A retired one has given its name
 * up, so it comes back as a new identity that resumes its session id.
 *
 * Durable identity is not durable context: `--resume` replays a transcript Claude Code owns and
 * may have reaped. A missing transcript is refused rather than launched, since `claude --resume`
 * on an unknown id exits without doing anything.
 */

/** A removed worktree that can be re-created, and the repository it was cut from. */
export interface ReattachTree {
  gitRoot: string;
  worktree: string;
  branch: string;
  adopted?: boolean;
}

/** The turn a headless resume starts on when the coordinator sent nothing to say. */
export const RESUMED_BRIEF = [
  "You have been resumed by agent-chat on your existing conversation, after your process had stopped.",
  "Your name and identity are unchanged. Check your inbox with chat_inbox for anything that arrived",
  "while you were stopped, then continue the work or report where it stands over agent-chat.",
].join(" ");

export const verdictLine = (t: TranscriptVerdict): string =>
  t.found ? `transcript found: ${t.path}` : `no transcript found at ${t.path}`;

/** CC-1472: why an identity cannot be resumed on any host, from its record alone. */
export function identityBlocker(agent: AgentIdentity): string | undefined {
  if (agent.state === "live")
    return `${agent.name} is already live; message it instead`;
  if (agent.sessionId === "")
    return `${agent.name} has no recorded session id, so there is no conversation to resume`;
  return undefined;
}

/**
 * Why an identity cannot be resumed, or undefined when it can. `reattach` says its gone
 * worktree can come back; `cwdExists` is the product's directory check.
 */
export function resumeBlocker(
  agent: AgentIdentity,
  transcript: TranscriptVerdict,
  cwdExists: (dir: string) => boolean,
  reattach?: ReattachTree
): string | undefined {
  const blocked = identityBlocker(agent);
  if (blocked !== undefined) return blocked;
  if (!transcript.found)
    return `${agent.name}'s transcript is gone, so it would come back with no conversation`;
  if (reattach === undefined && !cwdExists(agent.cwd))
    return `${agent.name}'s working directory ${agent.cwd} no longer exists. Not resumed`;
  return undefined;
}

/** The refusal for a name nothing live holds, pointing a retired one at the spawn route. */
export function missingAgent(
  name: string,
  retired: AgentIdentity | undefined,
  gone?: ReattachTree
): string {
  if (retired === undefined) return `no agent named "${name}"`;
  const where =
    gone === undefined
      ? `cwd="${retired.cwd}"`
      : `isolation="worktree" and cwd="${gone.gitRoot}"; its removed worktree ${gone.worktree} is re-created`;
  return (
    `${name} was retired, which gave up its name. Its session was ${retired.sessionId}; bring it back ` +
    `as a new agent with agent_spawn resume_session="${retired.sessionId}" and ${where}`
  );
}

/** The reply to a resume, shared by every surface so each says the same thing. */
export function describeResume(
  name: string,
  res: {
    ok: boolean;
    reason?: string;
    transcript?: TranscriptVerdict;
    warnings?: string[];
    deduped?: boolean;
    /** CC-1472: the machine a host resume launched on. */
    host?: string;
  }
): { ok: boolean; lines: string[] } {
  const verdict = [res.transcript === undefined ? "transcript: not looked up" : verdictLine(res.transcript)];
  if (!res.ok)
    return { ok: false, lines: [`Not resumed: ${res.reason}`, ...verdict] };
  return { ok: true, lines: [...resumedLines(name, res), ...verdict, ...warningLines(res)] };
}

const warningLines = (res: { warnings?: string[] }): string[] => (res.warnings ?? []).map((w) => `warning: ${w}`);

function resumedLines(name: string, res: { deduped?: boolean; host?: string }): string[] {
  // CC-1454: a retry answered from the first resume's outcome, so nothing launched twice.
  const deduped = res.deduped ? ["This resume already ran; this retry was not launched again."] : [];
  const on = res.host === undefined ? "" : ` on ${res.host}`;
  return [...deduped, `Resumed ${name}${on} on its existing conversation, keeping its name. Reach it with chat_send.`];
}
