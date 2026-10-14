import { addClaim, claimKey, sameClaim, type ClaimKey } from "./ops.js";
import type { BrakeState, Claim, LadderRecord, Ledger } from "./schema.js";
import type { StallCode } from "./vocab.js";

export type ClaimPatch = Partial<Omit<Claim, "taskId" | "slice" | "initiative">>;

/**
 * Ladder rung 2: the claim lets go of its worktree and branch, which stay. A slice goes back to `queued` for the
 * planner's work to survive; a whole task is dropped. Never clears `ledger.liveness`.
 */
export interface ReleaseAction {
  kind: "release";
  key: ClaimKey;
  branch?: string;
  requeue: boolean;
  /** Absent for a release that is no stall: a `stack-broken` release carries `reason` instead. */
  code?: StallCode;
  reason?: string;
  /** The agents that may still run, newest first; a retired one is no longer the broker's to retire. */
  names: string[];
}

/**
 * The actions `applyActions` reads, plus the side-effect kinds it passes through unchanged. A product's own action
 * union, whose spawn, retire and register carry product types, stays assignable to this one.
 */
export type LedgerAction =
  | { kind: "update"; key: ClaimKey; patch: ClaimPatch }
  | { kind: "add"; claims: Claim[] }
  /** Writes the claim's triage ladder record; absent prunes it. */
  | { kind: "ladder"; key: ClaimKey; record?: LadderRecord }
  /** Writes the ladder's brake; absent clears it. */
  | { kind: "brake"; brake?: BrakeState }
  | ReleaseAction
  | { kind: "spawn" | "retire" | "register" };

/** The ledger after `actions`; a phase change restarts the phase clock, and so does a new agent. */
export function applyActions(ledger: Ledger, actions: readonly LedgerAction[], now: Date): Ledger {
  const at = now.toISOString();
  return actions.reduce<Ledger>((current, action) => {
    if (action.kind === "add") return action.claims.reduce(addClaim, current);
    if (action.kind === "ladder") return withLadder(current, claimKey(action.key), action.record);
    if (action.kind === "release") return released(current, action, at);
    if (action.kind === "brake") return withBrake(current, action.brake);
    if (action.kind !== "update") return current;
    const claims = current.claims.map((c) =>
      c.phase !== "done" && sameClaim(c, action.key) ? patched(c, action.patch, at) : c,
    );
    return { ...current, claims };
  }, ledger);
}

/** A set brake moves to the last key, as agent-chat writes it, so the exported bytes match. */
function withBrake(ledger: Ledger, brake: BrakeState | undefined): Ledger {
  const rest = { ...ledger };
  delete rest.brake;
  return brake === undefined ? rest : { ...rest, brake };
}

function withLadder(ledger: Ledger, key: string, record: LadderRecord | undefined): Ledger {
  if (record !== undefined) return { ...ledger, ladder: { ...ledger.ladder, [key]: record } };
  const kept = { ...ledger.ladder };
  delete kept[key];
  const rest = { ...ledger };
  delete rest.ladder;
  return Object.keys(kept).length === 0 ? rest : { ...rest, ladder: kept };
}

/** What a requeued slice keeps: the planner's slice and who dispatched it, none of the last attempt. */
function requeued(claim: Claim, at: string): Claim {
  const { taskId, initiative, slice, dependsOn, owns, repo, contracts, overlapsAccepted, seat, namePrefix, spawnedAt } =
    claim;
  return {
    taskId,
    initiative,
    spawnedAt,
    phase: "queued",
    phaseAt: at,
    ...(slice === undefined ? {} : { slice }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(owns === undefined ? {} : { owns }),
    ...(repo === undefined ? {} : { repo }),
    ...(contracts === undefined ? {} : { contracts }),
    ...(overlapsAccepted === undefined ? {} : { overlapsAccepted }),
    ...(seat === undefined ? {} : { seat }),
    ...(namePrefix === undefined ? {} : { namePrefix }),
  };
}

/** Counts the release on the key's ladder record and the task's release record, so the backoff applies. */
function released(ledger: Ledger, action: ReleaseAction, at: string): Ledger {
  const key = claimKey(action.key);
  const held = (c: Claim): boolean => c.phase !== "done" && sameClaim(c, action.key);
  const claims = action.requeue
    ? ledger.claims.map((c) => (held(c) ? requeued(c, at) : c))
    : ledger.claims.filter((c) => !held(c));
  const taskId = action.key.taskId;
  return {
    ...ledger,
    claims,
    releases: { ...ledger.releases, [taskId]: { n: (ledger.releases?.[taskId]?.n ?? 0) + 1, at } },
    ladder: {
      ...ledger.ladder,
      [key]: releasedLadder(ledger.ladder?.[key], action, ledger.claims.find(held)?.seat, at),
    },
  };
}

/** The old `code` and `reason` go before the spread, so the new ones land where agent-chat writes them. */
function releasedLadder(
  record: LadderRecord | undefined,
  action: ReleaseAction,
  seat: string | undefined,
  at: string,
): LadderRecord {
  const kept: Partial<LadderRecord> = { ...record };
  delete kept.code;
  delete kept.reason;
  return {
    respawns: kept.respawns ?? 0,
    ...kept,
    releases: (kept.releases ?? 0) + 1,
    lastAt: at,
    ...(action.code === undefined ? {} : { code: action.code }),
    ...(action.reason === undefined ? {} : { reason: action.reason }),
    ...(action.branch === undefined ? {} : { branch: action.branch }),
    ...(seat === undefined ? {} : { seat }),
  };
}

const restarts = (claim: Claim, patch: ClaimPatch): boolean =>
  (patch.phase !== undefined && patch.phase !== claim.phase) ||
  (patch.agentName !== undefined && patch.agentName !== claim.agentName);

/** A new stall stamps `stalledAt` once; clearing the stall, or a new phase or agent, drops it and `stale`. */
function patched(claim: Claim, patch: ClaimPatch, at: string): Claim {
  const restart = restarts(claim, patch);
  const { stalledAt, stale, ...next } = { ...claim, ...patch, phaseAt: restart ? at : claim.phaseAt };
  if (next.stalledReason === undefined) return next;
  const since = claim.stalledReason === undefined ? at : stalledAt;
  return {
    ...next,
    ...(since === undefined ? {} : { stalledAt: since }),
    ...(stale === undefined || restart ? {} : { stale }),
  };
}
