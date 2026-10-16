import { z } from "zod";

/**
 * The closed set of codes a stall or a stalled-after-claim finding carries, in precedence order: when two hold, the
 * earlier wins. A stall outside these kinds keeps its `stalledClass` and carries no code.
 */
export const STALL_CODES = [
  "spawn-never-landed",
  "shepherd-ended",
  "planner-refused",
  "retry-spent",
  "budget",
  "outside-owns",
  "no-repo",
  "phase-timeout",
  "dirty-uncommitted",
  "lease-expired",
  "no-progress",
] as const;
export type StallCode = (typeof STALL_CODES)[number];

/**
 * Codes a respawn or release can fix. The others go straight to the owner: a respawn under `budget` would spend more,
 * and `outside-owns` holds until the PR drops the file.
 */
export const LADDER_CODES: readonly StallCode[] = [
  "spawn-never-landed",
  "phase-timeout",
  "dirty-uncommitted",
  "lease-expired",
  "no-progress",
];

/** What a stalled claim whose agent is gone is waiting on. */
export const STALE_CLASSES = [
  "nothing-to-do",
  "date-blocked",
  "retry-spent",
  "pr-closed",
  "blocked",
  "outside-owns",
  "timeout",
  "other",
] as const;
export type StaleClass = (typeof STALE_CLASSES)[number];

/** Why a claim stopped, which decides who may handle it. A gate-trip is an owner gate and is never triaged. */
export const EXCEPTION_CLASSES = ["stalled", "failed", "gate-trip"] as const;
export type ExceptionClass = (typeof EXCEPTION_CLASSES)[number];

export const CONTRACT_OPS = ["replace", "remove", "rename", "migrate", "add", "extend", "modify"] as const;
export type ContractOp = (typeof CONTRACT_OPS)[number];

export const DESTRUCTIVE_OPS: readonly ContractOp[] = ["replace", "remove", "rename", "migrate"];

export const ContractSchema = z.object({
  scope: z.string().trim().min(1),
  op: z.enum(CONTRACT_OPS),
});
export type Contract = z.infer<typeof ContractSchema>;

/** One open PR the slice may share one exact owns path with, because the planner read both edits as line-local. */
export const AcceptedOverlapSchema = z.object({
  pr: z.number().int().positive(),
  path: z.string().min(1),
  why: z.string().trim().min(1),
});
export type AcceptedOverlap = z.infer<typeof AcceptedOverlapSchema>;
