import { messageOf } from "./error-message.js";
import type { JournalRow } from "../host/ports.js";
import type { AgentIdentity } from "../roster/types.js";
import { allocatedWorktree, parkable } from "./park-rules.js";
import { isReviewerSpawn } from "./reviewer-names.js";
import { isFinishedReport } from "./retire-at-report.js";

/**
 * CC-1039: a spawned non-reviewer agent's tree is parked when the agent exits normally, without
 * waiting for CI and without CC-921's opt-in, because a clean tree whose HEAD origin holds loses
 * nothing: the park keeps the branch and `agent resume` re-creates the tree for a fix round. The
 * `agent park` rules still decide, so a dirty, unpushed or occupied tree stays. A tree a burndown
 * claim still reads stays too, since parking it would stall the claim.
 *
 * CC-976: a reviewer that exited on its final Verdict has its tree parked even when its spawner
 * never opted into CC-921, because a review tree holds no work. The agent is not retired.
 * Shepherd's reviewers never message their spawner; Shepherd reads the Verdict from the last
 * assistant turn of the transcript, often after a lead-in paragraph. So a Verdict line anywhere
 * in either the last report or the final assistant text counts.
 */

interface ParkPort {
  current(agentId: string): AgentIdentity | undefined;
  events(): readonly JournalRow[];
  /** `agent park` by id: refuses a live-cwd, dirty, off-branch or unpushed tree, and keeps the branch. */
  park(agentId: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface ImplementerParkPort extends ParkPort {
  /** `autoPark.onExit`, read per exit. */
  enabled(): boolean;
  /** Why a held burndown claim still reads `tree`, or undefined. */
  treeHold(tree: string): string | undefined;
}

export interface ReviewerParkPort extends ParkPort {
  /** The agent's last report to its spawner in this run, if any. */
  lastReport(agent: AgentIdentity): string | undefined;
  /** The final assistant text of the agent's transcript, if any. */
  finalText(agent: AgentIdentity): string | undefined;
}

export type ParkAtExitResult =
  | { action: "off" }
  | { action: "kept"; name: string; reason: string }
  | { action: "parked"; name: string; reason?: string };

export const NO_VERDICT = "no final Verdict report";

const VERDICT_LINE = /^[\s*_`#>]*verdict[*_`]*\s*:/im;

export const isVerdictText = (text: string): boolean =>
  isFinishedReport(text) || VERDICT_LINE.test(text);

/** Never rejects: a failure is a kept tree with the reason, named by id when the agent could not be read. */
async function guarded(
  port: ParkPort,
  agentId: string,
  applies: (agent: AgentIdentity) => boolean,
  run: (agent: AgentIdentity) => Promise<ParkAtExitResult>
): Promise<ParkAtExitResult> {
  let name = agentId;
  try {
    const agent = port.current(agentId);
    if (agent?.origin !== "spawned" || !applies(agent))
      return { action: "off" };
    name = agent.name;
    return await run(agent);
  } catch (err) {
    return { action: "kept", name, reason: messageOf(err) };
  }
}

async function parkAgent(
  port: ParkPort,
  agent: AgentIdentity
): Promise<ParkAtExitResult> {
  const parked = await port.park(agent.agentId);
  if (!parked.ok)
    return {
      action: "kept",
      name: agent.name,
      reason: parked.reason ?? "park refused",
    };
  return {
    action: "parked",
    name: agent.name,
    ...(parked.reason === undefined ? {} : { reason: parked.reason }),
  };
}

export function parkImplementerAtExit(
  port: ImplementerParkPort,
  agentId: string
): Promise<ParkAtExitResult> {
  return guarded(
    port,
    agentId,
    (agent) => !isReviewerSpawn(agent.profile, agent.name),
    async (agent) => {
      const target = allocatedWorktree(port.events(), agent.agentId);
      if (!parkable(target) || !port.enabled()) return { action: "off" };
      const held = port.treeHold(target.worktree);
      if (held !== undefined)
        return { action: "kept", name: agent.name, reason: held };
      return parkAgent(port, agent);
    }
  );
}

const hasVerdict = (port: ReviewerParkPort, agent: AgentIdentity): boolean =>
  [port.lastReport(agent), port.finalText(agent)].some(
    (text) => text !== undefined && isVerdictText(text)
  );

export function parkReviewerAtReport(
  port: ReviewerParkPort,
  agentId: string
): Promise<ParkAtExitResult> {
  return guarded(
    port,
    agentId,
    (agent) => isReviewerSpawn(agent.profile, agent.name),
    async (agent) => {
      if (!parkable(allocatedWorktree(port.events(), agent.agentId)))
        return { action: "off" };
      if (!hasVerdict(port, agent))
        return { action: "kept", name: agent.name, reason: NO_VERDICT };
      return parkAgent(port, agent);
    }
  );
}
