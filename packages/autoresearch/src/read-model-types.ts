import type { WorkflowStatus } from "@titan-design/workflow";
import type { z } from "zod";
import type { CellRow } from "./digest.js";
import type { LookAggregate, Planner, RoundSummary, StaticCheckSchema } from "./ports.js";
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
  ratchet: RoundSummary["ratchet"];
}

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
}
