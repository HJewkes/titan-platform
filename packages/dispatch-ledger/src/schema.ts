import { z } from "zod";
import { AcceptedOverlapSchema, ContractSchema, EXCEPTION_CLASSES, STALE_CLASSES, STALL_CODES } from "./vocab.js";

/**
 * The burndown claim ledger: which task each tick-spawned agent holds.
 *
 * A claim holds its task until its phase is `done`, and a lane only while an agent works on it. A stalled claim (a
 * `stalledReason`, or past its phase timeout) keeps both: it is filed to the backlog rather than respawned.
 */

export const PHASES = [
  "queued",
  "spawning",
  "planning",
  "implementing",
  "parked",
  "reviewing",
  "awaiting-merge",
  "shepherding",
  "done",
] as const;
export type Phase = (typeof PHASES)[number];

/** Phases a spawn lands in once its agent row appears. */
export const AGENT_PHASES = ["planning", "implementing", "reviewing"] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

/**
 * The unmerged parent slice a claim was admitted on, and the parent PR's head branch. `forkHead` is the parent head
 * the child's worktree was cut from, recorded once the spawn answers, to diagnose a restack against.
 */
const StackedOnSchema = z.object({
  taskId: z.string(),
  slice: z.string(),
  pr: z.string(),
  branch: z.string(),
  forkHead: z.string().optional(),
});
export type StackedOn = z.infer<typeof StackedOnSchema>;

const StaleSchema = z.object({
  class: z.enum(STALE_CLASSES),
  proposed: z.string(),
  since: z.string(),
  until: z.string().optional(),
});

const UnretiredSchema = z.object({
  name: z.string(),
  reason: z.string(),
  /** When it refused; a row with this name spawned later is a different agent. Absent on old rows. */
  at: z.string().optional(),
});

/** Set while the claim's live agent shows no progress in its transcript; the tick opens, refreshes and closes it. */
const FindingSchema = z.object({
  kind: z.literal("stalled-after-claim"),
  /** `lease` when the claim's lease gave the code; the others are transcript reads. */
  reason: z.enum(["silent", "idle", "slow-tool", "lease"]),
  code: z.enum(STALL_CODES).optional(),
  /** The last progress the transcript showed, or the spawn when it showed none. */
  since: z.string(),
  openedAt: z.string(),
  checkedAt: z.string(),
  detail: z.string(),
});

/** An implementing claim's progress lease, with the evidence it last saw. */
const LeaseSchema = z.object({
  /** The last commit, or the phase start before one. */
  progressAt: z.string(),
  leaseUntil: z.string(),
  /** Renewals without a commit since `progressAt`. */
  renewals: z.number().int().nonnegative(),
  head: z.string().optional(),
  /** The worktree's progress content hash. */
  content: z.string().optional(),
  /** The transcript's newest progress row. */
  transcriptAt: z.string().optional(),
});

/** This stall's triage job; kept once it ends, so one occurrence never starts a second job. */
const TriageSchema = z.object({
  /** The stall it is for; a record of another occurrence is dropped at the next settle. */
  occurrence: z.string(),
  /** When the stall first routed to triage; a capacity wait runs from here. */
  since: z.string(),
  outcome: z.enum(["waiting", "started", "refused", "ended", "fallback"]),
  name: z.string().optional(),
  /** When the frame was sent; the triage time cap runs from here. */
  startedAt: z.string().optional(),
  detail: z.string().optional(),
});

/** Who holds the claim, where it stands and what the planner declared for its slice. */
const ClaimCoreShape = {
  taskId: z.string(),
  initiative: z.string(),
  /** Set once the broker's roster shows the spawned agent; absent while `spawning`. */
  agentId: z.string().optional(),
  spawnedAt: z.string(),
  phase: z.enum(PHASES),
  /** When the claim entered its current phase; the timeout runs from here. */
  phaseAt: z.string(),
  /** A planner's slice letter; a task holds one claim per slice. */
  slice: z.string().optional(),
  /** Slices of the same task that must reach `done` first. */
  dependsOn: z.array(z.string()).optional(),
  /** Set when the slice was admitted before its one unmet `dependsOn` merged, stacked on that parent. */
  stackedOn: StackedOnSchema.optional(),
  /** The paths a planner's slice declares it touches; the collision check compares them to open PRs and file claims. */
  owns: z.array(z.string()).optional(),
  /** The files the tick added to `owns` when the PR touched them outside its slice; the reviewer judges scope. */
  ownsAmended: z.array(z.string()).optional(),
  /** The repo the slice's plan names; it outranks the task's tags. */
  repo: z.string().optional(),
  /** The contracts a planner's slice declares; absent means none. */
  contracts: z.array(ContractSchema).optional(),
  /** The open PRs and exact paths the planner accepts sharing; absent means none. */
  overlapsAccepted: z.array(AcceptedOverlapSchema).optional(),
  /** The agent the claim is waiting on now. */
  agentName: z.string().optional(),
  /** Every agent spawned for this claim, oldest first; retired newest first. */
  spawned: z.array(z.string()).optional(),
  /** Where a `spawning` claim goes once its agent row appears. */
  nextPhase: z.enum(AGENT_PHASES).optional(),
  /** The planner-profile agent writes a brief, not slices; its exit leaves the task for approval. */
  briefer: z.boolean().optional(),
  worktree: z.string().optional(),
  questionId: z.string().optional(),
  inboxCursor: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),
  /** Set once a silent exit with commits ahead got its one resume successor. */
  resumed: z.literal(true).optional(),
  reviewRound: z.number().int().nonnegative().optional(),
  pr: z.string().optional(),
  /** The PR's head commit when the tick last read it at a merge or a close. */
  prHead: z.string().optional(),
  lastReport: z.string().optional(),
  /** Shepherd runs the tick re-registered after a transient failure: how many, when last, and for which head. */
  reregistered: z.object({ n: z.number().int().positive(), at: z.string(), head: z.string().optional() }).optional(),
  /** The seat that dispatched the claim; absent for a claim from an initiative's autonomy block. */
  seat: z.string().optional(),
  /** Prefix of every agent name the claim spawns; absent means `bd`. */
  namePrefix: z.string().optional(),
};

/** Why the claim stopped and what the tick has done about it. */
const ClaimStallShape = {
  stalledReason: z.string().optional(),
  /** Set beside `stalledReason`; a row without one predates classes and routes to the owner. */
  stalledClass: z.enum(EXCEPTION_CLASSES).optional(),
  /** Set beside `stalledReason` for a stall of one of the closed kinds. */
  stallCode: z.enum(STALL_CODES).optional(),
  /** When `stalledReason` was set, for the reported stall age only. */
  stalledAt: z.string().optional(),
  /** The class of a stall whose agent is gone and the action proposed for it, told to the seat once. */
  stale: StaleSchema.optional(),
  /** A ladder rung-1 respawn under way: set as its agents are retired, cleared by the successor's spawn intent. */
  respawn: z.object({ code: z.enum(STALL_CODES), occurrence: z.string() }).optional(),
  /** Agents whose retire refused, in retire order; each tick, or the ladder respawn, retries them. */
  unretired: z.array(UnretiredSchema).optional(),
  /** Event kinds (`kind:code` for a coded stall) already delivered to the claim's seat, so none is re-sent. */
  notified: z.array(z.string()).optional(),
  /** The fact fingerprint of each delivered stall notice by its `notified` key, so an unchanged reopen stays quiet. */
  noticeFacts: z.record(z.string(), z.string()).optional(),
  finding: FindingSchema.optional(),
  /** The checkpoint request for the open `dirty-uncommitted` finding: `sentAt` once sent, `failed` counting refusals. */
  checkpoint: z.object({ sentAt: z.string().optional(), failed: z.number().int().positive().optional() }).optional(),
  lease: LeaseSchema.optional(),
  /** The claim's PR as the last leak check found it: redacted `file:line category` rows, never matched text. */
  leak: z.object({ repo: z.string(), url: z.string(), findings: z.array(z.string()) }).optional(),
  triage: TriageSchema.optional(),
};

export const ClaimSchema = z.object({ ...ClaimCoreShape, ...ClaimStallShape });
export type Claim = z.infer<typeof ClaimSchema>;

const DeciderStateSchema = z.object({
  /** Every wake the tick sent, oldest first, pruned to the last day; the rate caps count these. */
  wakes: z.array(z.string()),
  /** Why the last wake was refused; cleared by the next wake the broker accepts. */
  refused: z.object({ reason: z.string(), at: z.string() }).optional(),
});
export type DeciderState = z.infer<typeof DeciderStateSchema>;

/** One seven-day pool usage reading; the seat's pool gate reads these as its history. */
const SeatSampleSchema = z.object({
  at: z.number(),
  sevenDay: z.number(),
  resetsAt: z.number().optional(),
});

const SeatStateSchema = z.object({
  samples: z.array(SeatSampleSchema),
  /** Config dir the samples were read from; samples of another pool never share a series. */
  configDir: z.string().optional(),
  /** The reason set of the seat's last "dispatched nothing" log line and when it was written. */
  noDispatch: z.object({ key: z.string(), at: z.string() }).optional(),
  /** Ticks in a row on which nothing in the seat's scope was eligible; absent after a dispatch or a stop. */
  exhaustedTicks: z.number().int().positive().optional(),
});
export type SeatState = z.infer<typeof SeatStateSchema>;

/** How often a task was released and when last; the dispatcher turns it into a hold. */
const ReleaseRecordSchema = z.object({ n: z.number().int().positive(), at: z.string().datetime() });
export type ReleaseRecord = z.infer<typeof ReleaseRecordSchema>;

/** Failures of one action for one claim, counted per fact fingerprint. */
const LivenessRecordSchema = z.object({
  byFact: z.record(
    z.string(),
    z.object({
      n: z.number().int().positive(),
      firstAt: z.string().datetime(),
      lastAt: z.string().datetime(),
      lastText: z.string(),
    }),
  ),
});
export type LivenessRecord = z.infer<typeof LivenessRecordSchema>;

/** A claim's place on the triage ladder; kept on the ledger, apart from `attempt` and `reviewRound`. */
const LadderRecordSchema = z.object({
  /** Respawns whose successor spawned; one still under way is not counted. */
  respawns: z.number().int().nonnegative(),
  lastAt: z.string().datetime(),
  /** The occurrence (the claim's `phaseAt`) rung 1 started on. */
  occurrence: z.string().optional(),
  /** When the ladder last stalled the claim for its owner. */
  owner: z.string().datetime().optional(),
  /** Rung-2 releases of this key; absent before the first. */
  releases: z.number().int().nonnegative().optional(),
  /** The branch the last release kept, the stall code that sent it there, and the seat to tell. */
  branch: z.string().optional(),
  code: z.enum(STALL_CODES).optional(),
  /** Why a release that is no stall (`stack-broken`) happened; it replaces any earlier `code`. */
  reason: z.string().optional(),
  seat: z.string().optional(),
  /** Set when the seat's `released` notice failed to send, and cleared once one lands. */
  releaseDue: z.literal(true).optional(),
});
export type LadderRecord = z.infer<typeof LadderRecordSchema>;

/** The ladder's mass-death brake: occurrence times inside the window, and the notice sent for this brake. */
const BrakeStateSchema = z.object({
  at: z.array(z.string().datetime()),
  /** `brake:<code>` once told, so a later tick of the same brake is quiet. */
  notified: z.string().optional(),
  /** The claim keys the notice was about; their seats are told. */
  claims: z.array(z.string()).optional(),
  /** Occurrences already counted, as `<claim key>@<phaseAt>`, so a retried rung is not a new one. */
  seen: z.array(z.string()).optional(),
});
export type BrakeState = z.infer<typeof BrakeStateSchema>;

/** A seat's run of refused deliveries; `skipped` counts the ticks a stopped seat was held back since its last probe. */
const WakeRecordSchema = z.object({
  failed: z.number().int().positive(),
  reason: z.string().optional(),
  skipped: z.number().int().nonnegative().optional(),
});
export type WakeRecord = z.infer<typeof WakeRecordSchema>;

export const LedgerSchema = z.object({
  version: z.literal(1),
  lastTickAt: z.string().optional(),
  claims: z.array(ClaimSchema),
  decider: DeciderStateSchema.optional(),
  /** Per-seat pool samples, keyed by seat name. */
  seats: z.record(z.string(), SeatStateSchema).optional(),
  /**
   * When each seat's finished agents were last retired, by seat name. Beside `seats`, not in it: a seat state needs
   * pool samples, and a seat with none still retires.
   */
  dailyRetire: z.record(z.string(), z.string().datetime()).optional(),
  /** Keys of human-queue items the tick filed, so a finding that still holds is filed once. */
  humanFiled: z.array(z.string()).optional(),
  /** The scanner state the leak check last recorded, so a missing scanner is logged once rather than every tick. */
  leakScanner: z.string().optional(),
  /** The last finding rows of each part of a PR's leak scan, by PR URL; a part a tick cannot scan keeps its last one. */
  leakScans: z
    .record(z.string(), z.object({ text: z.array(z.string()).optional(), branch: z.array(z.string()).optional() }))
    .optional(),
  /** Release counts by task id, which hold the task back from dispatch. */
  releases: z.record(z.string(), ReleaseRecordSchema).optional(),
  /** Slices dropped one at a time, by task id; a dropped slice no longer gates the slices that depend on it. */
  slicesReleased: z.record(z.string(), z.array(z.string())).optional(),
  /** Tasks whose merged slices were told to their seat, as `<initiative>/<id>`, so each is told once. */
  slicesFlagged: z.array(z.string()).optional(),
  /** When each triage job was started, pruned to the last day; the daily triage cap counts these. */
  triageStarts: z.array(z.string()).optional(),
  /** Action failures by `<claim key>|<action>`; kept on the ledger so a claim drop does not reset the count. */
  liveness: z.record(z.string(), LivenessRecordSchema).optional(),
  /** Triage ladder records by claim key, outside the claim so a release keeps them. */
  ladder: z.record(z.string(), LadderRecordSchema).optional(),
  /** Persisted, so a restart inside the window stays braked. */
  brake: BrakeStateSchema.optional(),
  /** The last service check read; the line stops on two stopping reads in a row. */
  serviceCheck: z.object({ at: z.string().datetime(), cause: z.string().nullable() }).optional(),
  /** Consecutive refused deliveries by seat name; a delivered message drops the seat's entry. */
  wake: z.record(z.string(), WakeRecordSchema).optional(),
});
export type Ledger = z.infer<typeof LedgerSchema>;

export const EMPTY_LEDGER: Ledger = { version: 1, claims: [] };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const PHASE_TIMEOUT_MS: Partial<Record<Phase, number>> = {
  spawning: 10 * MINUTE_MS,
  planning: 2 * HOUR_MS,
  implementing: 4 * HOUR_MS,
  reviewing: 2 * HOUR_MS,
};
