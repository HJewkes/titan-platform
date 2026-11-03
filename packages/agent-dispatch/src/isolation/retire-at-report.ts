import { messageOf } from "./error-message.js";
import type { JournalRow } from "../host/ports.js";
import type { AgentIdentity } from "../roster/types.js";
import type { FinishedHolds } from "./retire-finished.js";
import { allocatedWorktree, liveBlocker, parkable } from "./park-rules.js";
import { adopterBlocker } from "./tenancy.js";

/**
 * CC-921: when an opted-in spawner's agent exits after a final `Status:` or `Verdict:`
 * report, the broker parks its clean, pushed tree and retires it, so seats stop spending
 * calls on closeout. The park keeps the branch and the retire keeps it too: nothing on this
 * path deletes a branch. Every check errs towards keeping: a kept tree costs a manual
 * retire, a wrong retire costs work or a Shepherd fix round.
 */

type Outcome = { ok: boolean; reason?: string };

export interface ReportRetirePort {
  current(agentId: string): AgentIdentity | undefined;
  roster(): AgentIdentity[];
  events(): readonly JournalRow[];
  /** Whether the spawner opted in through `autoRetire.onFinalReport`. */
  enabledFor(spawner: string): boolean;
  /** The text of the agent's last report to its spawner in this run, if any. */
  lastReport(agent: AgentIdentity): string | undefined;
  /** This broker still watches the agent's process. */
  tracked(agentId: string): boolean;
  holds: Pick<FinishedHolds, "shepherd">;
  /** `agent park` by id: refuses a live-cwd, dirty, off-branch or unpushed tree, and keeps the branch. */
  park(agentId: string): Promise<Outcome>;
  /** Retire by id with a branch-keeping release. */
  retire(agentId: string): Promise<Outcome>;
}

export type ReportRetireResult =
  | { action: "off" }
  | { action: "kept"; name: string; reason: string }
  | { action: "retired"; name: string; parked: boolean; reason?: string };

/** Never rejects: a failure is a kept agent with the reason. */
export async function retireAtReport(
  port: ReportRetirePort,
  agentId: string
): Promise<ReportRetireResult> {
  const agent = port.current(agentId);
  if (agent?.origin !== "spawned" || !port.enabledFor(agent.spawnedBy))
    return { action: "off" };
  try {
    return await closeOut(port, agent);
  } catch (err) {
    return { action: "kept", name: agent.name, reason: messageOf(err) };
  }
}

async function closeOut(
  port: ReportRetirePort,
  agent: AgentIdentity
): Promise<ReportRetireResult> {
  const agentId = agent.agentId;
  const kept = (reason: string): ReportRetireResult => ({
    action: "kept",
    name: agent.name,
    reason,
  });
  if (!isFinishedReport(port.lastReport(agent) ?? ""))
    return kept(NOT_FINISHED);
  const target = allocatedWorktree(port.events(), agentId);
  const blocked =
    adopterBlocker(agent, target, port.roster()) ??
    (await port.holds.shepherd(agent, target));
  if (blocked) return kept(blocked);
  const parked = parkable(target) ? await port.park(agentId) : undefined;
  if (parked?.ok === false) return kept(parked.reason ?? "park refused");
  const late = lateBlocker(port, agentId, agent.name);
  if (late) return kept(late);
  const retired = await port.retire(agentId);
  if (!retired.ok) return kept(retired.reason ?? "retire refused");
  return {
    action: "retired",
    name: agent.name,
    parked: parked !== undefined,
    ...reasonOf(retired),
  };
}

export const NOT_FINISHED =
  "no final Status: DONE, DONE_WITH_CONCERNS or Verdict report";

/**
 * Narrower than a terminal report: BLOCKED and NEEDS_CONTEXT close a turn but wait on a
 * follow-up resume, and a retired name cannot be resumed.
 */
const FINISHED_OPENING =
  /^[\s*_`#>]*(verdict[*_`]*\s*:|status[*_`]*\s*:[\s*_`]*(done|done_with_concerns)\b)/i;

export const isFinishedReport = (text: string): boolean =>
  FINISHED_OPENING.test(text);

/** The checks await, so the agent may have been resumed meanwhile. */
function lateBlocker(
  port: ReportRetirePort,
  agentId: string,
  name: string
): string | undefined {
  const now = port.current(agentId);
  if (now?.name !== name) return "no longer the agent that exited";
  const live = liveBlocker(now, port.tracked(agentId));
  return live === undefined ? undefined : `became ${live} before the retire`;
}

const reasonOf = (res: Outcome): { reason?: string } =>
  res.reason === undefined ? {} : { reason: res.reason };
