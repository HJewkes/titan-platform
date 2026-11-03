import { z } from "zod";

/**
 * The `/limits` report, version 1. Consumers (the agent-chat `limits` verb, the console's limits panel) parse it
 * with `limitsReportSchema`. v1 only ever gains optional fields; a renamed or removed field is a v2.
 */

const count = z.number().int().nonnegative();
const at = z.iso.datetime({ offset: true });
const roleName = z.enum(["implementers", "reviewers", "planners"]);

const leverBinding = z.strictObject({
  kind: z.literal("lever"),
  /** The refusal kind the lever made: role-cap, worktrees, slots or budget. */
  refusal: z.string().min(1),
  initiative: z.string().min(1),
  task: z.string().min(1).optional(),
  lever: z.string().min(1),
  value: z.number().nullable(),
  reading: z.number().nullable(),
  headroom: z.number().nullable(),
  source: z.string(),
});

/** No capacity lever refused: what the ready set ran out against, as refusal counts by kind. */
const supplyBinding = z.strictObject({
  kind: z.literal("supply"),
  ready: count,
  mix: z.record(z.string(), count),
});

export const limitsBindingSchema = z.discriminatedUnion("kind", [leverBinding, supplyBinding]);

export const ledgerOnlyClaimSchema = z.strictObject({
  initiative: z.string(),
  task: z.string(),
  slice: z.string().optional(),
  phase: z.string(),
  agentName: z.string().optional(),
  /** The CC-1150 stale class; null when the claim is not classified stale. */
  stale: z.string().nullable(),
  /** The disposition stamped on the claim; null when none is, or dispositions are not stamped at all. */
  disposition: z.string().nullable(),
});

export const roleReportSchema = z.strictObject({
  cap: count,
  /** The planner's own count after planning (the tick row's `roles.used`). */
  used: count,
  /** Held claims that hold a slot: spawning, a live agent, or a respawn under way. */
  live: count,
  spawning: count,
  hand: count,
  /** Every held claim of the role on the ledger, live or not. */
  ledger: count,
  handReserve: z.strictObject({ reserve: count, remaining: z.number().int() }).nullable(),
  ledgerOnly: z.array(ledgerOnlyClaimSchema),
});

const readingSchema = z.strictObject({ value: z.number(), ageMinutes: z.number().nonnegative() });

export const poolReportSchema = z.strictObject({
  pool: z.string().min(1),
  fiveHour: readingSchema.nullable(),
  sevenDay: readingSchema.nullable(),
  band: z.string().nullable(),
  pace: z.number().nullable(),
  reserve: z.string().nullable(),
});

export const blockerSchema = z.strictObject({
  pr: z.number().int().positive(),
  repo: z.string().optional(),
  /** Refusals of this kind that name the PR, every one counted (a task refused twice counts twice). */
  refusals: count,
  /** `<task>` or `<task> <slice>` for each refused unit, first-seen order. */
  slices: z.array(z.string()),
  files: z.array(z.string()),
  status: z.enum(["stalled", "registered", "not-ours", "unknown"]),
});

export const refusalKindSchema = z.strictObject({
  /** Refused units under the kind of their first refusal, as the tick row counts them. */
  count,
  /** Up to five PRs, most refusals first; only `file-overlap` and `open-pr` name PRs. */
  blockers: z.array(blockerSchema),
});

export const supplySchema = z.strictObject({
  ready: count,
  waiting: count,
  /** Units held in the burndown claim ledger: bookkeeping, never counted as a refusal. */
  seeded: count,
  readyAgeMinutes: z.strictObject({ p50: z.number().nullable(), p90: z.number().nullable() }),
  outOfScope: count,
});

export const worktreesSchema = z.strictObject({
  repos: z.record(z.string(), z.strictObject({ active: count, perRepoPerSeat: count.nullable() })),
  /** `totalCeiling - leftFree`; null when the broker reports no ceiling. */
  ceiling: z.number().int().nullable(),
  budget: count.nullable(),
});

export const contradictionSchema = z.strictObject({
  initiative: z.string(),
  task: z.string(),
  slice: z.string().optional(),
  class: z.string(),
  proposed: z.string(),
  since: z.string(),
  disposition: z.string().nullable(),
});

export const seatReportSchema = z.strictObject({
  binding: limitsBindingSchema,
  roles: z.record(roleName, roleReportSchema),
  pools: z.array(poolReportSchema),
  refusals: z.record(z.string(), refusalKindSchema),
  planBlocked: z.strictObject({ depBlocked: count, dead: z.record(z.string(), count) }),
  supply: supplySchema,
  worktrees: worktreesSchema,
  contradictions: z.strictObject({
    items: z.array(contradictionSchema),
    /** Null, never 0, while dispositions are not stamped. */
    undisposed: count.nullable(),
  }),
});

export const shepherdReportSchema = z.union([
  z.strictObject({
    runs: z.record(z.string(), count),
    held: z.array(z.strictObject({ run: z.string(), reason: z.string() })),
    reviews: z.strictObject({ inFlight: count, maxConcurrent: count.nullable() }),
  }),
  z.strictObject({ error: z.string().min(1) }),
]);

export const limitsReportSchema = z.strictObject({
  v: z.literal(1),
  at,
  seats: z.record(z.string(), seatReportSchema),
  /** Null when the caller made no Shepherd read. */
  shepherd: shepherdReportSchema.nullable(),
});

export type LimitsReport = z.infer<typeof limitsReportSchema>;
export type SeatReport = z.infer<typeof seatReportSchema>;
export type LimitsBinding = z.infer<typeof limitsBindingSchema>;
export type RoleReport = z.infer<typeof roleReportSchema>;
export type LedgerOnlyClaim = z.infer<typeof ledgerOnlyClaimSchema>;
export type PoolReport = z.infer<typeof poolReportSchema>;
export type RefusalBlocker = z.infer<typeof blockerSchema>;
export type RefusalKindReport = z.infer<typeof refusalKindSchema>;
export type SupplyReport = z.infer<typeof supplySchema>;
export type WorktreesReport = z.infer<typeof worktreesSchema>;
export type ContradictionReport = z.infer<typeof contradictionSchema>;
export type ShepherdReport = z.infer<typeof shepherdReportSchema>;
export type LimitsRole = z.infer<typeof roleName>;
