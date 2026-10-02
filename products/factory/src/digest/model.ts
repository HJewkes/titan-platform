import { z } from "zod";

/** One owner action; `keys` are the PR refs and run ids it names, so the same ask from two sources merges into one. */
export interface Ask {
  text: string;
  command?: string;
  source: string;
  keys: string[];
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
  /** Sources that could not be read, one line each, so a gap is never silent. */
  gaps: string[];
}

const NamedItem = z.object({ label: z.string(), detail: z.string().default("") });
const Reading = z.object({ sevenDay: z.number().optional(), fiveHour: z.number().optional() });

/** The subset of agent-chat's `digest --json` model the owner digest reads; unknown fields are ignored. */
export const AgentChatDigestSchema = z.object({
  ledger: z
    .object({
      available: z.boolean().default(false),
      escalations: z.array(z.object({ from: z.string(), text: z.string(), at: z.number() })).default([]),
      reports: z.array(z.object({ from: z.string(), at: z.number(), status: z.string(), line: z.string() })).default([]),
    })
    .default({ available: false, escalations: [], reports: [] }),
  readyToMerge: z.array(NamedItem).default([]),
  needsGrant: z.array(NamedItem).default([]),
  mergedPrs: z.array(NamedItem).default([]),
  stalled: z.array(z.object({ taskId: z.string(), agentId: z.string(), phase: z.string(), phaseAt: z.string() })).default([]),
  spend: z.array(z.object({ account: z.string(), now: Reading.optional(), stale: z.boolean().default(false) })).default([]),
  gaps: z.array(z.string()).default([]),
});

export type AgentChatDigest = z.infer<typeof AgentChatDigestSchema>;
