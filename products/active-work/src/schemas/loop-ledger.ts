/**
 * The platform open-loops ledger and its tech tree (TP-4316).
 *
 * Every field past the identity ones is optional so a sweep snapshot imports
 * unchanged, and unknown keys pass through so a later sweep can add columns
 * without a release.
 */
import { z } from 'zod';

export const LOOP_STATUSES = ['ACTIVE', 'STALLED', 'LOST', 'MISSING', 'DONE'] as const;
export const TIERS = ['S', 'A', 'B', 'C', 'parked'] as const;
export type Tier = (typeof TIERS)[number];

/** YAML 1.1 readers turn `2026-10-21` into a Date; the board always speaks strings. */
const dateText = z.union([z.string(), z.date().transform((d) => d.toISOString().slice(0, 10))]);

export const LedgerLoopSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  initiative: z.string().min(1),
  status: z.enum(LOOP_STATUSES),
  owning_seat: z.string().nullish(),
  done_when: z.string().nullish(),
  first_raised: dateText.nullish(),
  last_motion: z.object({ date: dateText, ref: z.string() }).nullish(),
  owner_emphasis: z
    .looseObject({
      score: z.number(),
      distinct_days: z.number(),
      last_raised: dateText.nullish(),
    })
    .nullish(),
  linked_tasks: z
    .object({ ids: z.array(z.string()), open: z.number(), done: z.number() })
    .nullish(),
  linked_prs_open: z.array(z.string()).nullish(),
  blockers: z
    .object({ owner_gated: z.array(z.string()), other: z.array(z.string()) })
    .nullish(),
  tech_tree_node: z.string().nullish(),
  tier: z.enum(TIERS).nullish(),
  tier_rank: z.number().nullish(),
  tier_set: z.object({ at: z.string(), by: z.enum(['proposal', 'owner']) }).nullish(),
});
export type LedgerLoop = z.infer<typeof LedgerLoopSchema>;

export const TreeNodeSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  goal: z.string(),
  depends_on: z.array(z.string()).default([]),
  loops: z.array(z.string()).default([]),
  state: z.enum(['done', 'in progress', 'not started']),
  done_when: z.string().default(''),
  churn: z
    .object({
      closed_14d: z.number(),
      open_now: z.number(),
      done_when_moved: z.enum(['yes', 'partly', 'no']),
      high_churn_no_progress: z.boolean(),
    })
    .default({ closed_14d: 0, open_now: 0, done_when_moved: 'no', high_churn_no_progress: false }),
});
export type LedgerTreeNode = z.infer<typeof TreeNodeSchema>;

/** Goals are `{ G1: "title" }` in the sweep's tree draft. */
export const TreeGoalsSchema = z.record(z.string(), z.string());

/** The mock's "Export tier JSON" shape; ids missing from it stay Unsorted. */
export const TierSeedSchema = z.partialRecord(
  z.enum(['S', 'A', 'B', 'C', 'Parked', 'parked']),
  z.array(z.string()),
);
export type TierSeed = z.infer<typeof TierSeedSchema>;
