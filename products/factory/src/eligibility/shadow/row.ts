/*
 * Shadow row v1 (TP-5755 PLAN 5.5): one JSON object per line, task keys only and never titles, so a row is safe to quote
 * in a public pull request. `kind` is a closed union with no `dispatched` member: the shadow can only say what it would do.
 */

interface RowLane {
  initiative: string;
  tag: string | null;
}

export type Stage = "eligibility" | "admission" | "upkeep" | "intake" | "stop";

/** Which bets the lane was judged against: the owner's selected ones, or its phase-2 sheet's proposed ones while none is selected. */
type Basis = "selected" | "proposed-sheet";

interface WakeRow {
  v: 1;
  kind: "wake";
  wake: string;
  at: string;
  build: string;
  rule_hash: string;
  lanes: number;
  /** "file" when any lane's plan came from the plan store because the daemon has no `plan.*` rpc; absent when no plan was read. */
  plan_read?: "rpc" | "file";
}

/** Set on a candidate whose pass needed the rule file's relax list, beside the codes the strict rules gave it. */
interface RelaxedFields {
  relaxed?: string[];
  strict_codes?: string[];
}

interface LaneRowBase {
  v: 1;
  wake: string;
  at: string;
  lane: RowLane;
  week: string;
  basis: Basis;
  /** On a proposed-sheet row when the rule file pins the sheets' week, which may differ from the calendar `week`. */
  sheet_week?: string;
}

export interface WouldDispatchRow extends LaneRowBase, RelaxedFields {
  kind: "would-dispatch";
  task: string;
  bet: string;
  rank: number;
  slot: number;
  free: number;
  class: string | null;
}

export interface RefusedRow extends LaneRowBase, RelaxedFields {
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
