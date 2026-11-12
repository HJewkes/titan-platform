/**
 * Typed inputs and rows of the ticket scorecard (TP-5446). The caller reads its stores and hands
 * these in already grouped per task; nothing here touches a file, a clock or the network.
 */

/** `recorded` when the value came from a field written at the source, else the heuristic that inferred it. */
export type Provenance = "recorded" | `inferred:${string}`;

/** A value with where it came from. */
export interface Labelled<T> {
  value: T;
  origin: Provenance;
}

export type TaskClass = "product" | "upkeep";

/** The census classifier still says `mixed`; the owner's 2026-11-12 decision maps it to upkeep. */
export type ClassLabel = TaskClass | "mixed";

export interface ScorecardTask {
  initiative: string;
  taskId: string;
  /** ISO datetime, or a date alone for older task files. */
  createdAt: string;
  doneAt: string | null;
  estimate: number | null;
}

/** An `agent_spawned` row linked to the task. `actor` is the spawner. */
export interface ScorecardSpawn {
  ts: string;
  actor: string;
  /** `meta.launched_by`; a Shepherd spawn is outside the dispatched population. */
  launchedBy: string | null;
  /** F12 `dispatch_rule`, once agent-chat records it. */
  dispatchRule: string | null;
  /** How the spawn was linked to the task; absent means its recorded `meta.task`. */
  link?: Provenance;
}

/** A `shepherd_registration` row for the task. */
export interface ScorecardRegistration {
  repo: string;
  pr: number;
}

/** A `shepherd-pr` workflow run for the task. */
export interface ScorecardRun {
  runId: string;
  /** The `stepId` of every entry in `step_results` (`<family>` or `<family>:<n>`), or just its family; one per iteration. */
  stepIds: readonly string[];
  /** Distinct heads awaited, as `task-actuals-shepherd` counts them. */
  reviewRounds: number;
  /** `shepherd_lineage` rows of this run whose role is `successor`. */
  successors: number;
}

/** A `hitl_gate` on one of the task's runs. */
export interface ScorecardGate {
  createdAt: string;
  resolvedAt: string | null;
  /** `resolved_by.class`, an authority actor class. */
  resolvedByClass: string | null;
}

/** A graph `pr` row. */
export interface ScorecardPr {
  repo: string;
  pr: number;
  mergedAt: string | null;
  closedAt: string | null;
}

export interface ScorecardFollowUp {
  taskId: string;
  estimate: number | null;
}

/** The task's cost from `taskActuals`, and how its sessions were linked to the task. */
export interface ScorecardActuals {
  usd: number;
  link: Provenance;
}

/** Where the rule pick placed the task in its dispatch week's pool. */
export interface RulePlacement {
  rankPct: number;
  inTopK: boolean;
}

/** Labels the caller supplies: recorded task fields, or the S3 inferred backfill. */
export interface ScorecardLabels {
  class?: Labelled<ClassLabel>;
  source?: Labelled<string>;
  serves?: Labelled<string>;
  rank?: Labelled<string>;
  doneReason?: Labelled<string>;
  revertedBy?: Labelled<string>;
  briefHasDoneWhen?: Labelled<boolean>;
  followUps?: Labelled<readonly ScorecardFollowUp[]>;
}

export interface TaskRowInput {
  task: ScorecardTask;
  spawns: readonly ScorecardSpawn[];
  registrations: readonly ScorecardRegistration[];
  runs: readonly ScorecardRun[];
  gates: readonly ScorecardGate[];
  prs: readonly ScorecardPr[];
  labels: ScorecardLabels;
  actuals?: ScorecardActuals;
  rule?: RulePlacement;
}

/** One dispatched task; keyed on (initiative, taskId). Null means not measured, never zero. */
export interface TaskRow {
  initiative: string;
  taskId: string;
  firstDispatchTs: string;
  dispatcher: string;
  dispatchRule: string | null;
  classAtDispatch: TaskClass | null;
  sourceAtDispatch: string | null;
  servesAtDispatch: string | null;
  rankAtDispatch: string | null;
  ageAtDispatchH: number | null;
  ruleRankPct: number | null;
  inRuleTopk: boolean | null;
  mergedAt: string | null;
  prs: number;
  fixRounds: number;
  reviewRounds: number;
  revertedBy: string | null;
  doneReason: string | null;
  followupsN: number | null;
  followupsEst: number | null;
  briefHasDoneWhen: boolean | null;
  leadCreatedDoneH: number | null;
  leadDispatchMergeH: number | null;
  usd: number | null;
  usdLink: Provenance | null;
  ownerGates: number;
  ownerGateHours: number;
  dupPrs: number;
  /** Per labelled column: `recorded`, or the heuristic that inferred it. */
  provenance: Readonly<Record<string, Provenance>>;
  inputsHash: string;
}
