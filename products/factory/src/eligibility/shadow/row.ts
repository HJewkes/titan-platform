/*
 * Shadow row v1 (TP-5755 PLAN 5.5): one JSON object per line, task keys only and never titles, so a row is safe to quote
 * in a public pull request. `kind` is a closed union with no `dispatched` member: the shadow can only say what it would do.
 */

interface RowLane {
  initiative: string;
  tag: string | null;
}

export type Stage = "eligibility" | "admission" | "upkeep" | "intake" | "stop";

/** Which bets the lane was judged against; later slices add the phase-2 sheet basis. */
type Basis = "selected";

interface WakeRow {
  v: 1;
  kind: "wake";
  wake: string;
  at: string;
  build: string;
  rule_hash: string;
  lanes: number;
}

interface LaneRowBase {
  v: 1;
  wake: string;
  at: string;
  lane: RowLane;
  week: string;
  basis: Basis;
}

export interface WouldDispatchRow extends LaneRowBase {
  kind: "would-dispatch";
  task: string;
  bet: string;
  rank: number;
  slot: number;
  free: number;
  class: string | null;
}

export interface RefusedRow extends LaneRowBase {
  kind: "refused";
  /** Null for a lane-level hold with no candidate task, so an empty held lane still shows. */
  task: string | null;
  stage: Stage;
  codes: string[];
  details?: string[];
  rank?: number;
  numbers?: Record<string, number>;
  /** A task stopped by its fix rounds: a planner looks once, and after that look the task parks. */
  next?: "planner-once" | "park";
  /** The bet's one owner question; shadow only records that it would be asked and files nothing. */
  would_ask?: true;
}

export type ShadowRow = WakeRow | WouldDispatchRow | RefusedRow;
