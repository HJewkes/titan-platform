import { messageOf } from "./error-message.js";
import { existsSync } from "node:fs";
import type { GitRunner } from "@titan-design/worktree";
import type { JournalRow, NamePresence } from "../host/ports.js";
import type { AgentIdentity } from "../roster/types.js";
import { heldBranches, type HeldBranch } from "./held-branches.js";
import {
  allocatedWorktree,
  liveBlocker,
  type ParkTarget,
} from "./park-rules.js";
import { adopterBlocker } from "./tenancy.js";
import { workBlocker } from "./work-blocker.js";

/**
 * CC-323: the skip rules for `agent retire --finished`. Every rule errs towards
 * skipping: a wrong skip costs a line of output, a wrong retire can lose work.
 * The retire itself still goes through the host's retire, so its refusals apply too.
 * CC-1325: it also keeps implementers, Shepherd-registered ones included, and reviewers while their PR is open.
 */

export interface RetireScope {
  spawner?: string;
  prefix?: string;
  /**
   * CC-1465: exited over STALE_AFTER_MS ago with no worktree left on disk, machine-wide unless the
   * other fields narrow it; at most STALE_RETIRE_CAP retires a call. The age and cap are the host's.
   */
  stale?: boolean;
}

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** One call's retires, so a backlog drains over passes instead of one long burst under the write lock. */
export const STALE_RETIRE_CAP = 200;

/** One agent in a bulk retire's plan: retired, or skipped for `reason`. */
export interface RetirePlanEntry {
  name: string;
  action: "retire" | "skip";
  reason?: string;
  /** CC-408: set, with `duplicate`, when another unretired row holds the same name. */
  agentId?: string;
  duplicate?: true;
}

/** What `retire` answered for one planned agent; `reason` on success is its caveat. */
export interface RetireResult {
  name: string;
  ok: boolean;
  reason?: string;
}

/**
 * CC-904, CC-950 and CC-1325: the reads that keep a finished agent whose PR still needs it. The host
 * implements them over Shepherd and `gh` and memoizes them for a whole plan, since each read spawns a
 * process. Each answers why the agent must stay, or undefined; a read that fails answers a skip.
 */
export interface FinishedHolds {
  /** A Shepherd run that names the agent or its branch, or an open PR no run has taken. */
  shepherd(
    agent: AgentIdentity,
    target: ParkTarget | undefined
  ): Promise<string | undefined>;
  /** An open PR on any of the branches that hold the agent. */
  openPr(candidates: readonly HeldBranch[]): Promise<string | undefined>;
}

/** What the bulk form reads from, and retires through, the host. */
export interface FinishedRetirePort {
  roster(): AgentIdentity[];
  events(): readonly JournalRow[];
  /** This broker still watches the agent's process. */
  tracked(agentId: string): boolean;
  parking(agentId: string): boolean;
  current(agentId: string): AgentIdentity | undefined;
  /** CC-408: liveness from the connected process, since a registry row can say `exited` while it runs. */
  presence(agent: AgentIdentity): NamePresence;
  /** CC-1138: why the caller may not retire this agent, keyed on its spawn row's parent id; undefined when it may. */
  ownership?(agent: AgentIdentity): string | undefined;
  /** CC-408: by id, so a stale row never resolves to the newest holder of its name. */
  retire(agentId: string): Promise<{ ok: boolean; reason?: string }>;
  git?: GitRunner;
  /** CC-904: the open-PR and Shepherd reads; the host always passes them. */
  holds?: FinishedHolds;
  /** Epoch ms the stale scope measures exit age against; defaults to the wall clock. */
  now?: () => number;
}

export interface FinishedRetireOutcome {
  ok: boolean;
  reason?: string;
  plan: RetirePlanEntry[];
  results: RetireResult[];
}

export const SCOPE_REQUIRED =
  "name --spawner or --prefix; --finished alone would sweep every agent on the machine";

interface Planned {
  agentId: string;
  entry: RetirePlanEntry;
}

/** Plan every in-scope agent, then retire the planned ones one at a time; one failure never stops the rest. */
export async function retireFinished(
  port: FinishedRetirePort,
  req: RetireScope & { dryRun?: boolean; caller?: string }
): Promise<FinishedRetireOutcome> {
  const malformed = malformedRequest(req);
  if (malformed) return { ok: false, reason: malformed, plan: [], results: [] };
  if (!hasScope(req))
    return { ok: false, reason: SCOPE_REQUIRED, plan: [], results: [] };
  const planned = await planFinished(port, req);
  const plan = planned.map((p) => p.entry);
  if (req.dryRun === true) return { ok: true, plan, results: [] };
  const results: RetireResult[] = [];
  for (const { agentId, entry } of planned)
    if (entry.action === "retire")
      results.push(await retireOne(port, agentId, entry.name));
  return { ok: results.every((r) => r.ok), plan, results };
}

/** The frame arrives from any socket client, so its field types are unchecked until here. */
function malformedRequest(
  req: RetireScope & { dryRun?: unknown }
): string | undefined {
  const field = (value: unknown, type: string): boolean =>
    value === undefined || typeof value === type;
  if (!field(req.spawner, "string")) return "spawner must be a string";
  if (!field(req.prefix, "string")) return "prefix must be a string";
  if (!field(req.dryRun, "boolean")) return "dryRun must be a boolean";
  if (!field(req.stale, "boolean")) return "stale must be a boolean";
  return undefined;
}

const hasScope = (scope: RetireScope): boolean =>
  scope.stale === true ||
  Boolean(scope.spawner?.trim()) ||
  Boolean(scope.prefix?.trim());

/** The stale scope stops planning at the cap, so the rest wait for the next call rather than a longer one. */
async function planFinished(
  port: FinishedRetirePort,
  scope: RetireScope & { caller?: string }
): Promise<Planned[]> {
  const roster = port.roster();
  const world = { roster, events: port.events() };
  const nowMs = (port.now ?? Date.now)();
  const cap =
    scope.stale === true ? STALE_RETIRE_CAP : Number.POSITIVE_INFINITY;
  const planned: Planned[] = [];
  let retires = 0;
  for (const agent of roster) {
    if (!inScope(agent, scope) || (scope.stale && !staleExit(agent, nowMs)))
      continue;
    if (retires >= cap) break;
    const entry = await planEntry(port, scope, agent, world);
    if (entry.action === "retire") retires++;
    planned.push({ agentId: agent.agentId, entry });
  }
  return planned;
}

async function planEntry(
  port: FinishedRetirePort,
  scope: RetireScope & { caller?: string },
  agent: AgentIdentity,
  { roster, events }: { roster: readonly AgentIdentity[]; events: readonly JournalRow[] }
): Promise<RetirePlanEntry> {
  const callers = [scope.caller, scope.spawner].filter(
    (name) => name?.trim()
  );
  const reason = callers.includes(agent.name)
    ? `${agent.name} is the caller itself, not an agent it spawned`
    : port.ownership?.(agent) ??
      (await finishedBlocker(
        port,
        agent,
        roster,
        events,
        scope.stale === true
      ));
  const base = { name: agent.name, ...duplicateOf(agent, roster) };
  return reason === undefined
    ? { ...base, action: "retire" }
    : { ...base, action: "skip", reason };
}

/** Only `exited`: a detached agent may be resumed in place, and a row with no exit time has no age. */
const staleExit = (agent: AgentIdentity, nowMs: number): boolean =>
  agent.state === "exited" &&
  agent.exitedAt !== undefined &&
  nowMs - agent.exitedAt >= STALE_AFTER_MS;

/** Teleport successors keep their predecessor's name, so a name alone cannot say which row the plan means. */
function duplicateOf(
  agent: AgentIdentity,
  roster: readonly AgentIdentity[]
): Pick<RetirePlanEntry, "agentId" | "duplicate"> {
  const twins = roster.filter(
    (a) => a.name === agent.name && a.agentId !== agent.agentId
  );
  return twins.length === 0 ? {} : { agentId: agent.agentId, duplicate: true };
}

async function finishedBlocker(
  port: FinishedRetirePort,
  agent: AgentIdentity,
  roster: readonly AgentIdentity[],
  events: readonly JournalRow[],
  stale: boolean
): Promise<string | undefined> {
  const byState =
    liveBlocker(agent, port.tracked(agent.agentId)) ??
    connectedBlocker(port, agent);
  if (byState) return byState;
  if (agent.origin !== "spawned")
    return "not spawned by agent-chat; retire it by name";
  if (port.parking(agent.agentId)) return "being parked";
  const target = allocatedWorktree(events, agent.agentId);
  if (stale && target !== undefined && existsSync(target.worktree))
    return `still holds ${target.worktree}; park it first`;
  const byAdopter = adopterBlocker(agent, target, roster);
  if (byAdopter) return byAdopter;
  const byHold = await holdBlocker(port.holds, agent, target, roster, events);
  if (byHold) return byHold;
  if (target === undefined) return undefined;
  return workBlocker(target, port.git).catch(
    (err: unknown) => `could not read ${target.worktree}: ${messageOf(err)}`
  );
}

async function holdBlocker(
  holds: FinishedHolds | undefined,
  agent: AgentIdentity,
  target: ParkTarget | undefined,
  roster: readonly AgentIdentity[],
  events: readonly JournalRow[]
): Promise<string | undefined> {
  if (holds === undefined) return undefined;
  return (
    (await holds.shepherd(agent, target)) ??
    (await holds.openPr(heldBranches(agent, target, roster, events)))
  );
}

/** The git checks await, so the agent may have been resumed meanwhile; check again right before retiring. */
async function retireOne(
  port: FinishedRetirePort,
  agentId: string,
  name: string
): Promise<RetireResult> {
  const now = port.current(agentId);
  if (now?.name !== name)
    return { name, ok: false, reason: "no longer the agent the plan named" };
  const late =
    liveBlocker(now, port.tracked(agentId)) ?? connectedBlocker(port, now);
  if (late) return { name, ok: false, reason: `became ${late} after the plan` };
  try {
    const res = await port.retire(agentId);
    return {
      name,
      ok: res.ok,
      ...(res.reason === undefined ? {} : { reason: res.reason }),
    };
  } catch (err) {
    return { name, ok: false, reason: messageOf(err) };
  }
}

/** A scope with no field would sweep every agent on the machine, so it matches nothing; `stale` narrows by age instead. */
export function inScope(agent: AgentIdentity, scope: RetireScope): boolean {
  if (!hasScope(scope)) return false;
  if (scope.spawner !== undefined && agent.spawnedBy !== scope.spawner)
    return false;
  return scope.prefix === undefined || agent.name.startsWith(scope.prefix);
}

export function connectedBlocker(
  port: Pick<FinishedRetirePort, "presence">,
  agent: AgentIdentity
): string | undefined {
  return port.presence(agent) === "self"
    ? `${agent.state}, but its process is still connected`
    : undefined;
}
