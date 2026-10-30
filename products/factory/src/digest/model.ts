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

/** One coordinator's merges and spawns in the window, read from Shepherd's runs and the broker roster. */
export interface SeatLine {
  seat: string;
  merges: number;
  spawns: number;
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
  /** Every gate waiting on the owner, oldest first, for the stale-gate alarm; `waiting` is this list cut to five. Absent when none is. */
  ownerGateAlarm?: WaitingGate[];
  /** The console origin the alarm links to; absent when `digest.consoleOrigin` is unset. */
  consoleOrigin?: string;
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

/** One stalled burndown claim, as agent-chat's own digest lists it. */
export interface StalledClaim {
  taskId: string;
  agentId: string;
  phase: string;
  phaseAt: string;
}

/** A BLOCKED or NEEDS_CONTEXT report an agent sent; `at` is epoch ms. */
export interface StatusReport {
  from: string;
  at: number;
  line: string;
}

/**
 * What the digest needs from agent-chat's ledger. The installed agent-chat prints no JSON digest and no other JSON read
 * carries these, so the CLI wires no source until agent-chat ships one (TP-4628).
 */
export interface AgentChatLedger {
  decided: Omit<DecidedLine, "overrule">[];
  reversals: ReversalLine[];
  stalled: StalledClaim[];
  reports: StatusReport[];
}
