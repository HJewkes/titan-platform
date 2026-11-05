import type { LimitsRole } from "./report-schema.js";

/**
 * What `limitsReport` reads, as plain data. A product adapter maps its planner's dry-run result, pool gate,
 * broker capacity and Shepherd read onto these shapes; the report never reads config, a ledger file or a roster.
 */

/** CC-1097: the lever behind a capacity refusal, with its figures; binary gates carry nulls. */
export interface LimitsGateReading {
  lever: string;
  value: number | null;
  reading: number | null;
  headroom: number | null;
  source: string;
}

/** The task a dep-blocked unit waits on, or the open PR a collision names. */
export type LimitsBlockerRef = { task: string; state: string } | { pr: number; repo: string };

/** One planner refusal, in the planner's rank order. */
export interface LimitsRefusal {
  initiative: string;
  task?: string;
  slice?: string;
  kind: string;
  reason: string;
  gate?: LimitsGateReading;
  blocker?: LimitsBlockerRef;
}

export interface LimitsRoleInput {
  cap: number;
  /** The planner's count after planning: held claims that hold a slot, hand spawns and this plan's dispatches. */
  used: number;
  hand: number;
  /** Slots of `cap` kept for hand spawns; absent when the seat keeps none. */
  handReserve?: number;
}

export interface LimitsPoolReading {
  value: number;
  readAt: string;
}

export interface LimitsPoolInput {
  pool: string;
  fiveHour?: LimitsPoolReading;
  sevenDay?: LimitsPoolReading;
  band?: string;
  pace?: number;
  reserve?: string;
}

export interface LimitsWorktreesInput {
  /** The seat's active worktrees per repo. */
  active: Readonly<Record<string, number>>;
  perRepoPerSeat?: number;
  totalCeiling?: number;
  leftFree?: number;
  budget?: number;
}

export interface LimitsPrStatus {
  pr: number;
  status: "stalled" | "registered" | "not-ours";
}

export interface LimitsSeatInput {
  seat: string;
  refusals: readonly LimitsRefusal[];
  roles: Readonly<Record<LimitsRole, LimitsRoleInput>>;
  /** Queued slices whose dependencies have merged, and those still waiting on a merge. */
  supply: { ready: number; waiting: number; readyAgesMinutes: readonly number[] };
  pools: readonly LimitsPoolInput[];
  worktrees: LimitsWorktreesInput;
  /** What the adapter knows of each blocking PR; a PR not listed reports `unknown`. */
  prs?: readonly LimitsPrStatus[];
}

export interface LimitsShepherdRun {
  id: string;
  phase: string;
  /** Set when Shepherd holds the run; the run then lists under `held` too. */
  holdReason?: string;
  /** A review dispatched with no verdict yet. */
  reviewInFlight?: boolean;
}

export type LimitsShepherdInput =
  | { runs: readonly LimitsShepherdRun[]; maxConcurrent?: number }
  | { error: string };

export interface LimitsPlanInput {
  seats: readonly LimitsSeatInput[];
  /** Agent names the roster shows able to run; a claim whose agent is not here holds no slot. */
  liveAgents: readonly string[];
  /** False until claims carry disposition stamps; then every disposition and `undisposed` read null. */
  dispositionsStamped: boolean;
  shepherd?: LimitsShepherdInput;
}

export interface LimitsClaim {
  taskId: string;
  initiative: string;
  slice?: string;
  seat?: string;
  phase: string;
  nextPhase?: string;
  agentName?: string;
  respawn?: unknown;
  stale?: { class: string; proposed: string; since: string };
  disposition?: string;
}

export interface LimitsLedger {
  claims: readonly LimitsClaim[];
}

export type LimitsClock = () => Date;
