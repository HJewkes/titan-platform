import { z } from "zod";

/*
 * The open-loops board contract (loops-pages plan 2026-10-27, "Data contract"): what active-work's
 * `loop board --json` (rpc `loop.board`) answers and what `loop tier` (rpc `loop.tier`) takes and
 * answers. The console parses both against these schemas and keeps no second copy, so the
 * active-work side only has to match this file.
 */

const LOOP_STATUSES = ["ACTIVE", "STALLED", "LOST", "MISSING", "DONE"] as const;
const LOOP_SOURCES = ["ledger", "session", "handoff", "teleport"] as const;
/** Tiers are advisory: coordinators weigh them and choose freely, and no dispatch code gates on one. */
const LOOP_TIERS = ["S", "A", "B", "C", "parked"] as const;

export type LoopStatus = (typeof LOOP_STATUSES)[number];
/** Null is Unsorted: the loop has no tier yet. */
export type LoopTier = (typeof LOOP_TIERS)[number] | null;

const tier = z.enum(LOOP_TIERS).nullable();

const boardLoop = z.object({
  /** A ledger id such as `loop-a`, or the session ref `<stem>#<id>`. */
  id: z.string(),
  title: z.string(),
  initiative: z.string(),
  status: z.enum(LOOP_STATUSES),
  tier,
  /** Order within the tier, set by `loop tier --before`. */
  tierRank: z.number().nullable(),
  tierSetBy: z.enum(["proposal", "owner"]).nullable(),
  ownerSeat: z.string().nullable(),
  doneWhen: z.string().nullable(),
  lastMotion: z.object({ date: z.string(), ref: z.string() }).nullable(),
  daysSinceMotion: z.number().nullable(),
  emphasis: z.object({ score: z.number(), distinctDays: z.number(), lastRaised: z.string().nullable() }).nullable(),
  tasks: z.object({ ids: z.array(z.string()), open: z.number(), done: z.number() }),
  prsOpen: z.array(z.string()),
  blockers: z.object({ ownerGated: z.array(z.string()), other: z.array(z.string()) }),
  /** The join key into `tree.nodes`. */
  treeNode: z.string().nullable(),
  source: z.enum(LOOP_SOURCES),
  /** Set when `source` is not `ledger`. */
  sessionRef: z.string().nullable(),
});

const treeNode = z.object({
  id: z.string(),
  title: z.string(),
  /** A key into `tree.goals`. */
  goal: z.string(),
  dependsOn: z.array(z.string()),
  /** The page derives "locked" from a not-started node with an unfinished dependency. */
  state: z.enum(["done", "in progress", "not started"]),
  doneWhen: z.string(),
  /** BoardLoop ids. */
  loops: z.array(z.string()),
  churn: z.object({
    closed14d: z.number(),
    openNow: z.number(),
    doneWhenMoved: z.enum(["yes", "partly", "no"]),
    highChurnNoProgress: z.boolean(),
  }),
});

export const loopBoard = z.object({
  /** Null until a ledger has been imported. */
  ledger: z.object({ path: z.string(), mtime: z.string().nullable() }).nullable(),
  loops: z.array(boardLoop),
  tree: z.object({ goals: z.array(z.object({ id: z.string(), title: z.string() })), nodes: z.array(treeNode) }).nullable(),
  /** Malformed ledger rows are skipped and named here, never thrown. */
  warnings: z.array(z.string()),
});

/** `loop.tier`'s args: `unsorted` takes the loop out of every tier, and `before` places it ahead of that loop. */
export const loopTierArgs = z.object({
  id: z.string().min(1),
  tier: z.enum([...LOOP_TIERS, "unsorted"]),
  before: z.string().min(1).optional(),
});

/** `loop.tier`'s answer: the moved loop's tier and rank as the ledger now holds them. */
export const loopTierAnswer = z.object({ id: z.string(), tier, tierRank: z.number().nullable() });

export type LoopBoard = z.infer<typeof loopBoard>;
export type BoardLoop = z.infer<typeof boardLoop>;
export type LoopTierArgs = z.infer<typeof loopTierArgs>;
