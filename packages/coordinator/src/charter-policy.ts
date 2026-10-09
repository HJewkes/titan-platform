import { z } from "zod";

const count = z.number().int().nonnegative();
const weight = z.number().nonnegative();
const weights = z.record(z.string(), weight);

export const HARD_STOP_CLASSES = [
  "ruleset-write",
  "tag-move",
  "npm-publish",
  "broker-restart",
  "launchd-install",
  "dotfiles-merge",
  "config-edit",
  "force-push",
  "deploy",
  "spend-money",
  "third-party-message",
  "personal-data",
] as const;

export const hardStopClassSchema = z.enum(HARD_STOP_CLASSES);

// Scorer terms are required because the scorer has no fallback for them; keys with no
// reader yet (gate_free_bonus, stale_pr_days, heartbeat_cron) stay optional so their
// owning slices can move them without breaking the parse.
export const charterDefaultsSchema = z.looseObject({
  kind_weights: weights,
  share_caps: weights,
  initiative_decay: weight,
  score_terms: z.looseObject({ severity: weight, priority_pct: weight, unblocks: weight, staleness: weight }),
  severity: z.looseObject({ critical: weight, high: weight, medium: weight, low: weight, unset: weight }),
  readiness: z.looseObject({ ready: weight, untriaged: weight, blocked: weight }),
  size: z.looseObject({ le3: weight, le8: weight, gt8: weight }),
  stop_short_factor: weight,
  gate_free_bonus: weight.optional(),
  retire_k: z.looseObject({ implementer: count, reviewer: count, planner: count }),
  teleport_k: count,
  worktrees_per_repo_per_seat: count,
  worktrees_left_free_per_repo: count,
  stale_pr_days: count.optional(),
  heartbeat_cron: z.string().optional(),
});

export const charterPoolSchema = z.looseObject({
  config_dir: z.string().min(1),
  human_uses: z.boolean(),
  ceiling_five_hour: z.number().nonnegative(),
  per_day_points: z.number().nonnegative(),
  reserve_seven_day: z.number().nonnegative().optional(),
  sonnet_band_points: z.number().nonnegative().optional(),
});

const poolNames = z.array(z.string().min(1));

// Each key is an initiative slug naming the pools that may fund its spawns; `default`
// covers every initiative not listed.
export const charterFundsSchema = z.object({ default: poolNames }).catchall(poolNames);

// Unknown keys pass through so a new charter key never breaks the parse; hard stops are
// closed because a misspelt class would silently stop guarding anything.
export const charterPolicySchema = z.looseObject({
  schema: z.literal("autonomy-charter/v1"),
  seats: z.array(z.string().min(1)).min(1),
  hub: z.string().min(1),
  hard_stops: z.array(hardStopClassSchema),
  defaults: charterDefaultsSchema,
  funds: charterFundsSchema,
  pools: z.record(z.string(), charterPoolSchema),
  title: z.string().optional(),
  created: z.string().optional(),
  owner_seat: z.string().optional(),
  charter_owner: z.string().optional(),
  root: z.string().optional(),
  human_only_initiatives: z.array(z.string()).optional(),
});

export const charterPolicyErrorSchema = z.object({
  code: z.enum(["missing", "invalid"]),
  path: z.string(),
  message: z.string(),
});

export type HardStopClass = z.infer<typeof hardStopClassSchema>;
export type CharterDefaults = z.infer<typeof charterDefaultsSchema>;
export type CharterPool = z.infer<typeof charterPoolSchema>;
export type CharterFunds = z.infer<typeof charterFundsSchema>;
export type CharterPolicy = z.infer<typeof charterPolicySchema>;
export type CharterPolicyError = z.infer<typeof charterPolicyErrorSchema>;
export type CharterPolicyResult =
  | { ok: true; policy: CharterPolicy }
  | { ok: false; errors: CharterPolicyError[] };

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let node = raw;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node;
}

function toError(raw: unknown, issue: z.core.$ZodIssue): CharterPolicyError {
  const missing = issue.path.length > 0 && valueAt(raw, issue.path) === undefined;
  return {
    code: missing ? "missing" : "invalid",
    path: issue.path.map(String).join("."),
    message: issue.message,
  };
}

/** Validates already-parsed charter front matter; never throws. */
export function parseCharterPolicy(raw: unknown): CharterPolicyResult {
  const parsed = charterPolicySchema.safeParse(raw);
  if (parsed.success) return { ok: true, policy: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((issue) => toError(raw, issue)) };
}
