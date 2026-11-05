import type { WorkflowStatus } from "@titan-design/workflow";
import type { z } from "zod";
import type { CellRow } from "./digest.js";
import type { CadenceRound, CadenceTrigger, LookAggregate, Planner, RatchetMoveSchema, Reeval, RoundSummary, SnapshotCutSchema, StaticCheckSchema, SyncResult } from "./ports.js";
import type { Registries } from "./registry.js";
import type { ArMicro, ArResult, Idea, ImplementerSchema, MetricSpec, Outcome, QueueOps } from "./schemas.js";
import type { RunSettings } from "./workflow.js";

/** An eval run under the console's name for its wall time. */
export type ArEvalView = Omit<ArResult, "wall_s"> & { wallS: number };

export interface ArMetricView {
  primary: string;
  direction: MetricSpec["primary"]["direction"];
  guards: string[];
  zeroTolerance: string[];
  /** The gate names the baseline ran when the all-gate rule is on; empty otherwise. */
  allGate: string[];
  noOp: string[];
  noise: { bandSigmas: number; lockAfterPairs: number; minPairs: number; defaultBandPp: number };
}

export interface ArTargetView {
  name: string;
  pin: string;
  ratchetRef: string;
  metric: ArMetricView;
  phases: string[];
  repo?: string;
  ratchetPrefix: string;
}

export type ArIdeaView = Idea & { lineageDepth: number };

export interface ArLadderView {
  idea: ArIdeaView;
  implementer: z.infer<typeof ImplementerSchema> | null;
  active: { stepId: string; firstStartedAt: string; restarts: number } | null;
  completed: { stepId: string; completedAt: string }[];
  implementUsd: number | null;
  l0: z.infer<typeof StaticCheckSchema> | null;
  micro: (ArMicro & { predictedDirectionMet: boolean }) | null;
  evals: ArEvalView[];
  /** The recorded stop, settled by `finalOutcomes` once its round's summary exists; null while the ladder runs. */
  outcome: Outcome | null;
}

export interface ArRoundView {
  round: number;
  queue: ArIdeaView[];
  rejected: { code: string }[];
  plannerRetried: boolean;
  planner?: Planner;
  exempt: QueueOps["exempt"];
  analysis: string[];
  selection: { picks: string[]; draws: { id: string; draw: number }[]; plannerTopK: string[] };
  ladders: ArLadderView[];
  /** The net move; `moves` holds each step of it. */
  ratchet: RoundSummary["ratchet"];
  moves: z.infer<typeof RatchetMoveSchema>[];
  reevals: ArReevalView[];
}

/** A later winner's re-evaluation on top of the round's new head, with its runs named as the console names them. */
export type ArReevalView = Omit<Reeval, "runs"> & { runs: ArEvalView[] };

/** A cut snapshot, with the trigger and round its recorded cadence decided. */
export type ArSnapshotView = Omit<z.infer<typeof SnapshotCutSchema>, "shepherdRunId"> & { trigger: CadenceTrigger; round: CadenceRound };

/**
 * One sync of the open snapshot PR. `conflict` and `frozen` say why a gate held; the other fields are where it settled.
 * `runs` are B's re-measure after main changed the tree, kept out of every ladder.
 */
export type ArSyncView = SyncResult & {
  round: CadenceRound;
  pr: number;
  gate?: { answered: boolean; resolved?: string };
  runs?: ArEvalView[];
  /** Why the sync failed; the PR stays open and the next round's sync retries it. */
  failed?: string;
};

export interface ArRunView {
  runId: string;
  status: WorkflowStatus;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  stopReason?: string;
  target: ArTargetView;
  settings: Pick<RunSettings, "lanes" | "rounds" | "minPool">;
  baseline: { runs: ArEvalView[]; b0: number };
  best: RoundSummary["best"];
  rounds: ArRoundView[];
  registries: Registries;
  cells: CellRow[];
  validator?: { maxLooks: number; looks: LookAggregate[] };
  snapshots: ArSnapshotView[];
  /** A phase-end cut that waited behind the open snapshot when the run ended. */
  snapshotPending: { trigger: CadenceTrigger } | null;
  syncs: ArSyncView[];
}

export interface ArRunSummary {
  runId: string;
  target: string;
  phase: string;
  round: number;
  rounds: number;
  status: WorkflowStatus;
  startedAt: string;
  completedAt: string | null;
  /** Null until every baseline eval is recorded. */
  best: RoundSummary["best"] | null;
  spend: number;
  /** The snapshot whose PR no sync has yet seen merged or closed. */
  openSnapshot: { k: number; pr: number } | null;
}
