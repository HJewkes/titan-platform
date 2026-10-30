import type { AgentIdentity } from "./types.js";

/**
 * Mode switching (CC-23): move a running agent between headless and a terminal
 * window, keeping its identity, its conversation and its place in the roster.
 * Only the plan lives here: who may switch what, where a surfaced agent lands, and
 * what the switched agent is told. Stopping and relaunching the process is the product's.
 *
 * Surfacing may be aimed at another agent, because the case it exists for is an agent too
 * stuck to ask: a blocked headless agent is invisible to the view that would unblock it.
 * Backgrounding is self-only, with no target field at all, so one peer cannot make
 * another's work invisible.
 *
 * A switch stops the process and resumes from the transcript, so an in-flight turn is lost.
 */

/** A placement the surface ladder understands; a surfaced agent lands on one of these. */
export type SurfacePlacement = "iterm-tab" | "iterm-pane";

/** Told to an agent that has just been pulled into a terminal by someone else. */
export const SURFACED_NOTICE = [
  "You were moved from headless into a terminal window so a human can see you and answer anything",
  "you are blocked on. Your identity, name and conversation are unchanged; the turn you were part",
  "way through when this happened was interrupted, so re-check anything you believe you had just",
  "finished. Carry on from here.",
].join(" ");

/** The continuation turn a backgrounded agent resumes on, since `-p` refuses without one. */
export const BACKGROUNDED_BRIEF = [
  "You have been moved out of a terminal window and are now running headless, at your own request.",
  "Your identity, name and conversation are unchanged. Nobody is watching a pane for you now, so",
  "you will not be prompted for permission — anything that would need approval will simply be",
  "denied. Continue the work you were doing, and report progress over agent-chat rather than to a",
  "screen.",
].join(" ");

export interface SwitchOutcome {
  ok: boolean;
  reason?: string;
  name?: string;
  agentId?: string;
  /** Where it actually landed, which the placement ladder may have downgraded. */
  surface?: string;
  warnings?: string[];
}

const isInteractiveSurface = (surface: string): boolean =>
  surface !== "headless";

/**
 * Where a surfaced agent should appear: beside its requester when the requester has a
 * window, otherwise in a window of its own. With no anchor `iterm-tab` falls down the
 * ladder to a new window, which needs no anchor and so cannot fail to find one.
 */
export function placementFor(anchor: string | undefined): SurfacePlacement {
  return anchor === undefined ? "iterm-tab" : "iterm-pane";
}

/** Shared by both directions: an identity has to be one the product can relaunch. */
function relaunchable(
  identity: AgentIdentity | undefined,
  name: string
): string | undefined {
  if (identity === undefined) return `no agent named "${name}"`;
  if (identity.origin === "adopted")
    return (
      `${name} is an ordinary session this broker did not launch, so there is no launch plan to ` +
      "rebuild it from. A session can move itself with agent_teleport instead."
    );
  if (identity.state === "retired") return `${name} has been retired`;
  return undefined;
}

/** Can this agent be pulled into a terminal, and is there any point? */
export function checkSurfaceable(
  identity: AgentIdentity | undefined,
  name: string
): string | undefined {
  const blocked = relaunchable(identity, name);
  if (blocked) return blocked;
  if (isInteractiveSurface((identity as AgentIdentity).surface))
    return `${name} is already in a terminal; \`agent-chat agent attach ${name}\` goes to it`;
  return undefined;
}

/**
 * Can this agent send ITSELF headless?
 *
 * `hostPid` is refused rather than worked around: signalling the MCP subprocess instead of
 * Claude Code severs the bus and leaves a live session no peer can reach and that cannot tell.
 */
export function checkBackgroundable(
  identity: AgentIdentity | undefined,
  name: string,
  hostPid: number | undefined
): string | undefined {
  const blocked = relaunchable(identity, name);
  if (blocked) return blocked;
  if (!isInteractiveSurface((identity as AgentIdentity).surface))
    return `${name} is already running headless`;
  if (hostPid === undefined)
    return (
      "this session did not report the pid of Claude Code itself, so the broker cannot end it " +
      "without severing the bus and leaving it running. Its MCP server predates this feature — " +
      "restart the session (or run /mcp reconnect) and try again."
    );
  return undefined;
}
