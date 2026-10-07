import { z } from "zod";

const count = z.number().int().nonnegative();

export const seatRepoSchema = z.looseObject({
  path: z.string(),
  remote: z.string().optional(),
  default: z.string().optional(),
  initiatives: z.array(z.string()).optional(),
  git: z.boolean().optional(),
  live_after: z.string().optional(),
  public: z.boolean().optional(),
  confidential: z.boolean().optional(),
  read_only: z.boolean().optional(),
  local_only: z.boolean().optional(),
  shared_with: z.array(z.string()).optional(),
  overflow_until: z.string().optional(),
});

export const seatSpendSchema = z.looseObject({
  per_run_points: z.number().optional(),
  per_day_points: z.number().optional(),
});

export const seatConcurrencySchema = z.looseObject({
  implementers: count,
  reviewers: count,
  planners: count,
  analysts: count.optional(),
});

// Unknown keys pass through so a new seat key never breaks the parse.
export const seatConfigSchema = z.looseObject({
  schema: z.literal("autonomy-seat/v1"),
  name: z.string().min(1),
  prefix: z.string().min(1),
  pool: z.string().min(1),
  config_dir: z.string().min(1),
  concurrency: seatConcurrencySchema,
  spend: seatSpendSchema,
  role: z.string().optional(),
  attended: z.boolean().optional(),
  profile: z.string().optional(),
  surface: z.string().optional(),
  host: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  overflow_pool: z.string().optional(),
  pools: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  heartbeat_cron: z.string().optional(),
  backlog: z.string().optional(),
  initiatives: z.record(z.string(), z.number()).optional(),
  scope_tags: z.array(z.string()).optional(),
  unclaimed_engineering: z.boolean().optional(),
  task_sources: z.array(z.unknown()).optional(),
  repos: z.array(seatRepoSchema).optional(),
  deny_repos: z.array(z.string()).optional(),
  kind_weights: z.record(z.string(), z.number()).optional(),
  share_caps: z.record(z.string(), z.number()).optional(),
  excluded_tags: z.array(z.string()).optional(),
  excluded_title_patterns: z.array(z.string()).optional(),
  extra_hard_stops: z.array(z.string()).optional(),
  grants_extra: z.array(z.string()).optional(),
  log: z.string().optional(),
  queue: z.string().optional(),
  dispatch_log: z.string().optional(),
  digest_to: z.string().nullable().optional(),
});

export type SeatConfig = z.infer<typeof seatConfigSchema>;
export type SeatRepo = z.infer<typeof seatRepoSchema>;
export type SeatSpend = z.infer<typeof seatSpendSchema>;
export type SeatConcurrency = z.infer<typeof seatConcurrencySchema>;
