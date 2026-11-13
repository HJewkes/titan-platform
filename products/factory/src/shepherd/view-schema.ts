import { z } from "zod";
import { AttestedSchema } from "./attest-schema.js";
import { AutoPassedSchema } from "./auto-pass.js";
import { TIMELINE_EVENT_KINDS } from "./ci-timeout-entry.js";
import { NONE_KINDS } from "./none-reason.js";
import { OWNER_GATE_REASONS } from "./policy-schema.js";
import { STAGES } from "./stage-times.js";
import { PhaseSchema } from "./step-phase.js";

/** Listed here, and tied to wake.ts's unions by a type check in view.ts, so this leaf never imports wake.ts. */
export const WAKE_KINDS = ["ci-red", "review", "conflict", "fix-proof"] as const;
export const WAKE_MODES = ["resume", "successor", "live"] as const;

export const RiskTierSchema = z.object({ tier: z.enum(["low", "medium", "high"]), reasons: z.array(z.string()) });

/** The read model `shepherd.list` and `shepherd.timeline` return; TP-466 section 2 pins these shapes for the UI. */
export const WatchRowSchema = z.object({
  repo: z.string(),
  pr: z.number().int().nullable(),
  branch: z.string(),
  runId: z.string(),
  task: z.string(),
  phase: PhaseSchema,
  headSha: z.string().nullable(),
  phaseSince: z.string(),
  nextAction: z.string(),
  pendingGate: z.object({ gateId: z.string(), stepId: z.string(), since: z.string() }).nullable(),
  held: z.object({ reason: z.string(), satisfiedAt: z.string().optional(), satisfiedBy: z.string().optional() }).nullable(),
  stalled: z.object({ reason: z.string() }).nullable(),
  /** How the run ended: `merged`, or `stopped` with the land reason; null while it runs and for runs older than the record. */
  outcome: z.object({ kind: z.enum(["merged", "stopped"]), reason: z.string().nullable() }).nullable(),
  /** The stage a live run is in and the whole minutes it has spent there; absent for a finished run and in rows older than the field. */
  stage: z.object({ name: z.enum(STAGES), minutes: z.number().int() }).nullable().optional(),
  /** Why an owner-gate run asks the owner; absent for other policies and for runs registered before the field. */
  ownerGateReason: z.enum(OWNER_GATE_REASONS).optional(),
  /** Whole minutes from the run's registration to its end, or to now while it runs. */
  totalMinutes: z.number().int().optional(),
  /** The registration's implementer and slice label, each null when it names none (only a slice-less run closes its task). Absent in rows older than the fields. */
  implementer: z.string().nullable().optional(),
  slice: z.string().nullable().optional(),
  /** The agent name the newest started `sh-review` dispatched; null before any reviewer started. Absent in rows older than the field. */
  reviewer: z.string().nullable().optional(),
  /** Why the newest head-level review step ended in `none`; null for a finished run or one whose last review gave a verdict. Absent in rows older than the field. */
  lastNone: z.object({ kind: z.enum(NONE_KINDS), text: z.string() }).nullable().optional(),
  repoFrozen: z.object({ repo: z.string(), reason: z.string(), actor: z.string(), since: z.string() }).optional(),
  autoPassed: AutoPassedSchema.optional(),
  /** The attestation rows the newest merge evidence recorded as met (TP-3110); absent when none was. */
  attested: AttestedSchema.optional(),
  /** The risk tier the newest merge evidence at the row's head recorded (TP-3734 r1, shadow); absent before any evidence there. */
  riskTier: RiskTierSchema.optional(),
});
export type WatchRow = z.infer<typeof WatchRowSchema>;

export const TimelineEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("step"),
    stepId: z.string(),
    iteration: z.number().int(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    signal: z.string().nullable(),
    status: z.enum(["running", "done", "failed"]),
  }),
  z.object({ kind: z.literal("ci"), stepId: z.string(), headSha: z.string(), conclusion: z.string(), runUrl: z.string().nullable() }),
  z.object({
    kind: z.literal("wake"),
    stepId: z.string(),
    /** Null where the step's record does not say: an implementer wake records its outcome, not its request. */
    request: z.enum(WAKE_KINDS).nullable(),
    /** Null for the FIX_FIRST counter, which is recorded before the wake it counts. */
    outcome: z.enum(["woken", "unhandled"]).nullable(),
    agent: z.string().nullable(),
    mode: z.enum(WAKE_MODES).nullable(),
    sessionId: z.string().nullable(),
    /** Why a held wake started no fixer: agent-chat's refusal of the successor. */
    held: z.string().optional(),
  }),
  z.object({
    kind: z.literal("verdict"),
    stepId: z.string(),
    verdict: z.enum(["MERGE", "FIX_FIRST", "none"]),
    headSha: z.string().nullable(),
    locator: z.object({ path: z.string(), start: z.number(), end: z.number() }).nullable(),
    /** For a `none` from Shepherd's own review, the reviewer whose MERGE a seat held; never the seat agent. */
    reviewer: z.string().nullable(),
    /** Why a `none` gave no verdict, in the status line's words; null for a MERGE or FIX_FIRST. */
    note: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("gate"),
    stepId: z.string(),
    gateId: z.string(),
    status: z.string(),
    createdAt: z.string(),
    resolvedAt: z.string().nullable(),
    resolvedBy: z.string().nullable(),
  }),
  /** A release Shepherd decided by a rule (TP-5403): the rule, the head it released at, and the reviewer and profile it took. */
  z.object({ kind: z.literal("decision"), stepId: z.string(), rule: z.string(), head: z.string(), reviewer: z.string(), profile: z.string() }),
  z.object({
    kind: z.literal("event"),
    event: z.enum(TIMELINE_EVENT_KINDS),
    reason: z.string().nullable(),
    actor: z.string().nullable(),
    at: z.string(),
    headSha: z.string().nullable(),
  }),
]);
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
