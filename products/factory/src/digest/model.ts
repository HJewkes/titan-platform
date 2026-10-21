import { z } from "zod";
import type { WaitingGate } from "../shepherd/waiting.js";
import type { FrictionDay } from "../shepherd/owner-friction.js";

/** One owner action; `keys` are the PR refs and run ids it names, so the same ask from two sources merges into one. */
export interface Ask {
  text: string;
  command?: string;
  source: string;
  keys: string[];
  /** A URL or command that shows the facts behind the ask. */
  evidence?: string;
  /** ISO time the ask was already open before this window started. */
  since?: string;
}

export interface Merged {
  ref: string;
  title: string;
  /** ISO time it finished, when the source knows it. */
  at?: string;
}

export interface Stuck {
  ref: string;
  reason: string;
  /** ISO time it has been stuck since; sorting puts the oldest first. */
  since: string;
}

/** A throwaway proof PR's run, listed apart from the owner's asks so a mislabelled real PR is still seen. */
export interface ProofFixture {
  ref: string;
  /** Each gate the run has pending, as a step id and its summary. */
  gates: string[];
  /** ISO time the run entered its phase; the section reads it as an age. */
  since: string;
}

/** An owner gate a run passed on a demotion rule in the window, shown so the owner sees what passed without them. */
export interface AutoPassed {
  ref: string;
  rule: string;
  headSha: string;
  detail: string;
}

export interface SeatLine {
  seat: string;
  dispatches: number;
  usd: number;
}

export interface PoolLine {
  pool: string;
  sevenDay?: number;
  fiveHour?: number;
  stale: boolean;
}

export interface DigestSlot {
  /** Local calendar date of the slot, YYYY-MM-DD. */
  date: string;
  /** Local slot hour, two digits. */
  hour: string;
}

/** Flow over the window: how long merged work took from task to merge, and how many merges an implementer hour bought. */
export interface FlowStats {
  /** Runs merged in the window. */
  merged: number;
  /** Merged runs with no task or no readable task file; left out of the p50, never imputed. */
  missing: number;
  taskToMergeP50Hours?: number;
  implementerHours: number;
  /** Non-live implementers whose end time the roster does not give. While any exist the rate is withheld, since the hours would count only agents still running. */
  unmeasured: number;
  /** Absent when no implementer hours were measured or any implementer's span could not be. */
  mergesPerSlotHour?: number;
}

/** One question the decider answered for the owner; `overrule` is the command that replaces the answer, set only while the decision awaits audit. */
export interface DecidedLine {
  questionId: string;
  question: string;
  answer: string;
  class: string;
  state: string;
  reversible?: string;
  confidence?: number;
  principleIds?: string[];
  overrule?: string;
}

/** Decisions per class over the last week and how many the owner overruled. */
export interface ReversalLine {
  class: string;
  decided: number;
  overruled: number;
}

/** Everything one digest says, as data; ranking and rendering never read a source. */
export interface DigestModel {
  slot: DigestSlot;
  generatedAt: string;
  since: string;
  needsYou: Ask[];
  merged: Merged[];
  stuck: Stuck[];
  seats: SeatLine[];
  spend: PoolLine[];
  /** Live `proof-fixture` runs with their gates; absent when there are none. They count in no section above. */
  proofFixtures?: ProofFixture[];
  /** Owner gates passed on a demotion rule in the window (TP-3697); absent when none was. */
  autoPassed?: AutoPassed[];
  /** The five oldest gates waiting on the owner, oldest first; absent when none is. */
  waiting?: WaitingGate[];
  /** Task-to-merge p50 and merges per implementer slot-hour; absent when the task or roster port is not wired or the roster could not be read. */
  flow?: FlowStats;
  /** The latest day of owner friction; absent when the gate store could not be read. */
  friction?: FrictionDay;
  /** Questions the decider answered in the window, oldest first; absent when there are none. */
  decided?: DecidedLine[];
  /** The 7-day reversal rate per class; read only alongside `decided`. */
  reversals?: ReversalLine[];
  /** Sources that could not be read, one line each, so a gap is never silent. */
  gaps: string[];
}

const NamedItem = z.object({ label: z.string(), detail: z.string().default("") });
/** `reversible`, `confidence` and `principleIds` come from a newer agent-chat (TP-695 c) and are read when present. */
const DecidedEntry = z.object({
  questionId: z.string(),
  question: z.string(),
  answer: z.string(),
  class: z.string(),
  state: z.string(),
  reversible: z.string().optional(),
  confidence: z.number().optional(),
  principleIds: z.array(z.string()).optional(),
});
const Reversal = z.object({ class: z.string(), decided: z.number(), overruled: z.number() });
const Reading = z.object({ sevenDay: z.number().optional(), fiveHour: z.number().optional() });

/** The subset of agent-chat's `digest --json` model the owner digest reads; unknown fields are ignored. */
export const AgentChatDigestSchema = z.object({
  ledger: z
    .object({
      available: z.boolean().default(false),
      escalations: z.array(z.object({ from: z.string(), text: z.string(), at: z.number() })).default([]),
      reports: z.array(z.object({ from: z.string(), at: z.number(), status: z.string(), line: z.string() })).default([]),
      decided: z.array(DecidedEntry).default([]),
      reversals: z.array(Reversal).default([]),
    })
    .default({ available: false, escalations: [], reports: [], decided: [], reversals: [] }),
  readyToMerge: z.array(NamedItem).default([]),
  needsGrant: z.array(NamedItem).default([]),
  mergedPrs: z.array(NamedItem).default([]),
  stalled: z.array(z.object({ taskId: z.string(), agentId: z.string(), phase: z.string(), phaseAt: z.string() })).default([]),
  spend: z.array(z.object({ account: z.string(), now: Reading.optional(), stale: z.boolean().default(false) })).default([]),
  gaps: z.array(z.string()).default([]),
});

export type AgentChatDigest = z.infer<typeof AgentChatDigestSchema>;
