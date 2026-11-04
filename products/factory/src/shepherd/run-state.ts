import type { WorkflowContext } from "@titan-design/workflow";
import type { RepoSlug } from "@titan-design/github";
import type { CiSnapshot } from "../workflows/land-ci.js";
import type { Escalated } from "./route-table.js";

export interface PrTarget {
  repo: RepoSlug;
  pr: number;
}

/** What the run's owner gates read: its context, its pull request, and the wait counter the await-new-head steps number from. */
export interface GateRun {
  ctx: WorkflowContext;
  target: PrTarget;
  state: { waits: number };
  /** An owner-gated escalation whose gate the head moved past; it gates every head until the owner answers an approve-merge gate. */
  carried?: Escalated;
  /** The verdict taken at each head; a waived fix-proof drops its head's NO_REPRO, so the next round reviews that head. */
  reviews?: Map<string, unknown>;
}

export interface ConflictBaseRun extends Pick<GateRun, "ctx" | "target"> {
  lastCi?: CiSnapshot;
  /** The base sha read at the last conflict; replaying the recorded step results rebuilds it. */
  conflictBase?: string;
  conflictBaseReads: number;
}

export interface OrderRun {
  ctx: WorkflowContext;
  target: PrTarget;
  orderSteps: number;
  /** Set by a recorded reservation and cleared by its release or expiry, so a replay rebuilds it. */
  reserved?: boolean;
  /** Set once a reservation was released short of landing, so the run's next landable head takes it again. */
  retake?: boolean;
  /** Set when a conflict leaves a resolved head to land, so the round it ended keeps the reservation. */
  resolving?: boolean;
}

export interface ConflictRun extends GateRun, ConflictBaseRun, OrderRun {
  /** Conflict wakes since the PR was last green or its base moved past the fixer's merge (`conflictAtNewBase`). */
  conflictWakes: number;
}

export interface RetargetRun extends ConflictRun {
  lastCi?: CiSnapshot;
  /** The base GitHub moved the PR off, from the last CI read before the move until a green head; replay rebuilds it. */
  retargetedFrom?: string;
}
