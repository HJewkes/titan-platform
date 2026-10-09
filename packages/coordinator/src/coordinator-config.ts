import { limitsSchema } from "@titan-design/agent-dispatch/limits";
import { z } from "zod";
import { charterDefaultsSchema, charterPolicySchema } from "./charter-policy.js";
import { seatConfigSchema, seatRepoSchema } from "./seat-config.js";

const clock = z.string().regex(/^\d{2}:\d{2}$/);

export const coordinatorOwnerSchema = z.looseObject({
  seat: z.string().min(1),
  timezone: z.string().min(1).optional(),
  day_starts_at: clock.optional(),
  digest_at: z.array(clock).optional(),
  channels: z.array(z.enum(["console", "telegram", "matrix"])).optional(),
  decider: z
    .looseObject({ enabled: z.boolean(), question_age_minutes: z.number().int().positive().optional() })
    .optional(),
});

// A seat is keyed by its name, takes its config dir from its pool and names repos by id,
// so those three seat-file keys leave the seat file's schema; everything else is reused.
export const coordinatorSeatSchema = seatConfigSchema
  .omit({ schema: true, name: true, config_dir: true, repos: true })
  .extend({
    repos: z.array(z.string().min(1)).optional(),
    dispatch: z.string().min(1).optional(),
  });

export const coordinatorPolicySchema = z.looseObject({
  hard_stops: charterPolicySchema.shape.hard_stops,
  hard_stop_repos: z.record(z.string(), z.array(z.string())).optional(),
  human_only_tag: z.string().min(1).optional(),
  defaults: charterDefaultsSchema.partial().optional(),
});

// Loose like the seat and charter schemas, so a newer key never breaks an older reader;
// limits stays strict because agent-dispatch owns it.
export const coordinatorConfigSchema = z.looseObject({
  $schema: z.literal("titan-coordinator/v1"),
  owner: coordinatorOwnerSchema,
  state_dir: z.string().min(1).nullable().optional(),
  service: z.looseObject({ label_prefix: z.string().min(1).optional() }).optional(),
  task_sources: z.record(z.string(), z.looseObject({ kind: z.string().min(1) })).optional(),
  repos: z.record(z.string(), seatRepoSchema),
  seats: z.record(z.string(), coordinatorSeatSchema),
  limits: limitsSchema,
  policy: coordinatorPolicySchema,
});

export const coordinatorConfigErrorSchema = z.object({
  code: z.enum(["missing", "invalid", "reference"]),
  path: z.string(),
  message: z.string(),
});

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
export type CoordinatorSeat = z.infer<typeof coordinatorSeatSchema>;
export type CoordinatorOwner = z.infer<typeof coordinatorOwnerSchema>;
export type CoordinatorPolicy = z.infer<typeof coordinatorPolicySchema>;
export type CoordinatorConfigError = z.infer<typeof coordinatorConfigErrorSchema>;
export type CoordinatorConfigResult =
  | { ok: true; config: CoordinatorConfig }
  | { ok: false; errors: CoordinatorConfigError[] };

type Seats = [name: string, seat: CoordinatorSeat][];

function reference(path: string, message: string): CoordinatorConfigError {
  return { code: "reference", path, message };
}

function hasValueAt(raw: unknown, path: readonly PropertyKey[]): boolean {
  let node = raw;
  for (const key of path) {
    if (node === null || typeof node !== "object") return false;
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return node !== undefined;
}

function schemaError(raw: unknown, issue: z.core.$ZodIssue): CoordinatorConfigError {
  const missing = issue.path.length > 0 && !hasValueAt(raw, issue.path);
  return { code: missing ? "missing" : "invalid", path: issue.path.map(String).join("."), message: issue.message };
}

function attendedErrors(config: CoordinatorConfig, seats: Seats): CoordinatorConfigError[] {
  const attended = seats.filter(([, seat]) => seat.attended === true).map(([name]) => name);
  const errors: CoordinatorConfigError[] = [];
  if (attended.length !== 1) {
    errors.push(reference("seats", `exactly one seat must be attended; found ${attended.length}`));
  }
  if (!attended.includes(config.owner.seat)) {
    errors.push(reference("owner.seat", `${config.owner.seat} is not an attended seat`));
  }
  return errors;
}

type PoolRefs = { pool?: string; overflow_pool?: string; pools?: string[] };

function poolRefs(path: string, refs: PoolRefs): [path: string, pool: string][] {
  return [
    ...(refs.pool === undefined ? [] : [[`${path}.pool`, refs.pool] as [string, string]]),
    ...(refs.overflow_pool === undefined ? [] : [[`${path}.overflow_pool`, refs.overflow_pool] as [string, string]]),
    ...(refs.pools ?? []).map((pool, i): [string, string] => [`${path}.pools.${i}`, pool]),
  ];
}

function unknownPools(config: CoordinatorConfig, refs: [string, string][]): CoordinatorConfigError[] {
  return refs
    .filter(([, pool]) => !Object.hasOwn(config.limits.pools, pool))
    .map(([path, pool]) => reference(path, `pool ${pool} is not in limits.pools`));
}

function repoErrors(config: CoordinatorConfig, seats: Seats, name: string, seat: CoordinatorSeat) {
  return (seat.repos ?? []).flatMap((id, i) => {
    const path = `seats.${name}.repos.${i}`;
    const repo = Object.hasOwn(config.repos, id) ? config.repos[id] : undefined;
    if (!repo) return [reference(path, `repo ${id} is not in repos`)];
    const users = seats.filter(([, other]) => other.repos?.includes(id)).map(([user]) => user);
    const unlisted = users.filter((user) => !repo.shared_with?.includes(user));
    if (users.length < 2 || unlisted.length === 0) return [];
    return [reference(path, `repo ${id} is shared, but repos.${id}.shared_with lacks ${unlisted.join(", ")}`)];
  });
}

function seatErrors(config: CoordinatorConfig, seats: Seats): CoordinatorConfigError[] {
  return seats.flatMap(([name, seat], index) => {
    const errors = [...unknownPools(config, poolRefs(`seats.${name}`, seat)), ...repoErrors(config, seats, name, seat)];
    const earlier = seats.slice(0, index).find(([, other]) => other.prefix === seat.prefix);
    if (earlier) {
      errors.push(reference(`seats.${name}.prefix`, `prefix ${seat.prefix} is already used by ${earlier[0]}`));
    }
    if (Object.hasOwn(seat, "config_dir")) {
      errors.push(reference(`seats.${name}.config_dir`, "config_dir belongs on the limits pool, not the seat"));
    }
    return errors;
  });
}

// The same pool walk as agent-dispatch's checkLimits, kept here because that one needs a
// clock and reports no key paths.
function limitsPoolRefs(config: CoordinatorConfig): [string, string][] {
  const { funds = {}, seats = {}, profiles = {}, overrides = [] } = config.limits;
  return [
    ...Object.entries(funds).flatMap(([fund, pools]) =>
      pools.map((pool, i): [string, string] => [`limits.funds.${fund}.${i}`, pool]),
    ),
    ...Object.entries(seats).flatMap(([name, seat]) => poolRefs(`limits.seats.${name}`, seat)),
    ...Object.entries(profiles).flatMap(([name, profile]) =>
      Object.keys(profile.pools ?? {}).map((pool): [string, string] => [`limits.profiles.${name}.pools.${pool}`, pool]),
    ),
    ...overrides.flatMap((override, i) =>
      (override.pools ?? []).map((pool, j): [string, string] => [`limits.overrides.${i}.pools.${j}`, pool]),
    ),
  ];
}

function limitsErrors(config: CoordinatorConfig): CoordinatorConfigError[] {
  const unknownSeats = Object.keys(config.limits.seats ?? {})
    .filter((name) => !Object.hasOwn(config.seats, name))
    .map((name) => reference(`limits.seats.${name}`, `seat ${name} is not in seats`));
  return [...unknownSeats, ...unknownPools(config, limitsPoolRefs(config))];
}

function policyErrors(config: CoordinatorConfig): CoordinatorConfigError[] {
  const stops: readonly string[] = config.policy.hard_stops;
  return Object.keys(config.policy.hard_stop_repos ?? {})
    .filter((stop) => !stops.includes(stop))
    .map((stop) => reference(`policy.hard_stop_repos.${stop}`, `${stop} is not in policy.hard_stops`));
}

/** Validates a titan-coordinator/v1 document and its cross-references; never throws. */
export function checkCoordinatorConfig(raw: unknown): CoordinatorConfigResult {
  const parsed = coordinatorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => schemaError(raw, issue)) };
  }
  const config = parsed.data;
  const seats: Seats = Object.entries(config.seats);
  const errors = [
    ...attendedErrors(config, seats),
    ...seatErrors(config, seats),
    ...limitsErrors(config),
    ...policyErrors(config),
  ];
  return errors.length === 0 ? { ok: true, config } : { ok: false, errors };
}
