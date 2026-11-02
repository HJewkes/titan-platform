import { messageOf } from "./error-message.js";
import type { AgentIdentity } from "../roster/types.js";
import { heldBranches } from "./held-branches.js";
import {
  allocatedWorktree,
  liveBlocker,
  parkable,
  type ParkTarget,
} from "./park-rules.js";
import {
  reportPr,
  type PrHead,
  type PrState,
  type PrStateReader,
} from "./pr-state.js";
import {
  connectedBlocker,
  type FinishedHolds,
  type FinishedRetirePort,
} from "./retire-finished.js";
import { adopterBlocker, occupantOf } from "./tenancy.js";

/**
 * CC-1678: coordinators retired each exited worker by hand once its PR landed, so the broker does it.
 * The PR is the one the worker's last report names. Every check errs towards keeping, as CC-921's
 * do: a kept agent costs a later pass, a wrong retire costs work. Park keeps the branch and refuses
 * unpushed work, with the PR's head as backing because a merge may have deleted its branch on origin.
 */

type Outcome = { ok: boolean; reason?: string };

export const MERGED_RETIRE_EVERY_MS = 15 * 60_000;
/** A backlog drains over passes, since an answer already held costs nothing. */
export const PR_READS_PER_PASS = 20;
/** An open PR, or a failed read, is asked about again after this; a terminal state never is. */
export const PR_REREAD_MS = 60 * 60_000;

export type PrRead = (pr: string) => Promise<PrState | undefined>;

export interface MergedRetirePort
  extends Pick<
    FinishedRetirePort,
    "roster" | "events" | "current" | "tracked" | "parking" | "presence"
  > {
  /** The text of the agent's last report to its spawner in this run, if any. */
  lastReport(agent: AgentIdentity): string | undefined;
  /** Why a held burndown claim still reads `tree`, or undefined. */
  treeHold(tree: string): string | undefined;
  holds: FinishedHolds;
  readPr: PrRead;
  /** `agent park` by id, with the process check on and `head` as backing. */
  park(agentId: string, head: PrHead): Promise<Outcome>;
  /** Retire by id with a branch-keeping release. */
  retire(agentId: string): Promise<Outcome>;
}

export type MergedRetireResult =
  | { action: "kept"; name: string; pr: string; reason: string }
  | { action: "retired"; name: string; pr: string; parked: boolean };

const WORKER_PROFILE = /(^|-)(implementer(-lite)?|reviewer|adversary)$/;

export const isWorkerProfile = (profile: string): boolean =>
  WORKER_PROFILE.test(profile);

const isCandidate = (agent: AgentIdentity): boolean =>
  agent.state === "exited" &&
  agent.origin === "spawned" &&
  isWorkerProfile(agent.profile);

/** A pass's reader over answers that outlive it, so one PR costs one read however many agents name it. */
export function passPrReads(
  read: PrStateReader,
  clock: () => number = Date.now
): () => PrRead {
  const answers = new Map<string, { state: PrState | undefined; at: number }>();
  const settled = ({
    state,
    at,
  }: {
    state: PrState | undefined;
    at: number;
  }): boolean =>
    (state !== undefined && state.state !== "OPEN") ||
    clock() - at < PR_REREAD_MS;
  return () => {
    let left = PR_READS_PER_PASS;
    return async (pr) => {
      const held = answers.get(pr);
      if (held !== undefined && settled(held)) return held.state;
      if (left === 0) return undefined;
      left--;
      const state = await read(pr).catch(() => undefined);
      answers.set(pr, { state, at: clock() });
      return state;
    };
  };
}

/** One sweep; retires one at a time, and one failure never stops the rest. An open PR reports nothing. */
export async function retireMerged(
  port: MergedRetirePort
): Promise<MergedRetireResult[]> {
  const results: MergedRetireResult[] = [];
  for (const agent of port.roster().filter(isCandidate)) {
    const pr = reportPr(port.lastReport(agent) ?? "");
    const state = pr === null ? undefined : await port.readPr(pr);
    if (pr === null || state === undefined || state.state === "OPEN") continue;
    results.push(await retireOne(port, agent, pr, state.head));
  }
  return results;
}

async function retireOne(
  port: MergedRetirePort,
  agent: AgentIdentity,
  pr: string,
  head: PrHead
): Promise<MergedRetireResult> {
  try {
    return await closeMerged(port, agent, pr, head);
  } catch (err) {
    return keptResult(agent, pr, messageOf(err));
  }
}

function keptResult(agent: AgentIdentity, pr: string, reason: string): MergedRetireResult {
  return { action: "kept", name: agent.name, pr, reason };
}

async function closeMerged(
  port: MergedRetirePort,
  agent: AgentIdentity,
  pr: string,
  head: PrHead
): Promise<MergedRetireResult> {
  const kept = (reason: string): MergedRetireResult => keptResult(agent, pr, reason);
  const target = allocatedWorktree(port.events(), agent.agentId);
  const held =
    stateBlocker(port, agent) ??
    treeBlocker(port, agent, target) ??
    (await prBlocker(port, agent, target));
  if (held) return kept(held);
  const parked = parkable(target)
    ? await port.park(agent.agentId, head)
    : undefined;
  if (parked?.ok === false) return kept(parked.reason ?? "park refused");
  const late = lateBlocker(port, agent.agentId);
  if (late) return kept(late);
  const retired = await port.retire(agent.agentId);
  if (!retired.ok) return kept(retired.reason ?? "retire refused");
  return {
    action: "retired",
    name: agent.name,
    pr,
    parked: parked !== undefined,
  };
}

/** The checks await, so the agent may have been resumed meanwhile. */
function lateBlocker(port: MergedRetirePort, agentId: string): string | undefined {
  const now = port.current(agentId);
  return now === undefined ? "no longer on the roster" : stateBlocker(port, now);
}

function stateBlocker(
  port: MergedRetirePort,
  agent: AgentIdentity
): string | undefined {
  if (port.parking(agent.agentId)) return "being parked";
  return (
    liveBlocker(agent, port.tracked(agent.agentId)) ??
    connectedBlocker(port, agent)
  );
}

/** A reviewer holds no tree of its own, so its cwd is the tree a live fix round may be standing in. */
function treeBlocker(
  port: MergedRetirePort,
  agent: AgentIdentity,
  target: ParkTarget | undefined
): string | undefined {
  const roster = port.roster();
  const tree = target?.worktree ?? agent.cwd;
  const occupant = tree === "" ? undefined : occupantOf(tree, roster);
  if (occupant) return `${occupant.name} is ${occupant.state} in ${tree}`;
  return (
    adopterBlocker(agent, target, roster) ??
    (target && port.treeHold(target.worktree))
  );
}

/** The reported PR being done says nothing of a later one on the branch, or of a Shepherd reviewer's re-ask. */
async function prBlocker(
  port: MergedRetirePort,
  agent: AgentIdentity,
  target: ParkTarget | undefined
): Promise<string | undefined> {
  const byShepherd = await port.holds.shepherd(agent, target);
  if (byShepherd) return byShepherd;
  return port.holds.openPr(
    heldBranches(agent, target, port.roster(), port.events())
  );
}

/** Runs `pass` on an unref'd interval, never two at once. Returns its cancel. */
export function startMergedRetireSweep(
  pass: () => Promise<void>,
  everyMs = MERGED_RETIRE_EVERY_MS
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void pass()
      .catch(() => undefined)
      .finally(() => (running = false));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
