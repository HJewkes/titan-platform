import { LAYERED_FIELDS, LIMIT_DEFAULTS, clampToBounds, type LayeredField } from "./defaults.js";
import type { LimitsBlock, ParsedLimits } from "./parse.js";
import type { Grant, Lift, LimitsOverride, PoolLimits } from "./schema.js";

export type LimitLayer = "code" | "defaults" | "pool" | "profile" | "profile_pool" | "override" | "grant" | "seat";

export type ResolvedField = LayeredField | "per_run_points";

export interface ResolveInput {
  pool: string;
  profile?: string;
  seat?: string;
  now: Date;
  grants?: readonly Grant[];
  /** Question ids the owner answered, read from the event log. A grant whose question is absent is ignored. */
  answeredQuestions?: ReadonlySet<string>;
  /** The pool's current five-hour reset. A grant that outlasts it is ignored. */
  fiveHourResetsAt?: Date;
}

export interface ResolvedLimits {
  pool: string;
  config_dir: string;
  human_uses: boolean;
  ceiling_five_hour: number;
  reserve_seven_day: number;
  per_day_points: number | null;
  per_run_points: number | null;
  sonnet_band_points: number;
  dispatch_seven_day_points: number;
  dispatch_five_hour_points: number;
  pick_margin_five_hour: number;
  present_ceiling_five_hour: number;
  present_within_minutes: number;
  lift: Lift | null;
  band_fallback: string | null;
  context_tokens: number | null;
  sources: Record<ResolvedField, LimitLayer>;
  /** `override:<decision>` and `grant:<question>` for every time-boxed entry that set a field. */
  applied: string[];
  clamped: ResolvedField[];
}

export type ResolveResult = { open: true; limits: ResolvedLimits } | { open: false; reason: string };

type LayerValues = Partial<Record<LayeredField, number | boolean | null | undefined>>;
type Contribution = { layer: LimitLayer; values: LayerValues; tag?: string };

function selects(selector: readonly string[] | undefined, value: string | undefined): boolean {
  return selector === undefined || (value !== undefined && selector.includes(value));
}

export function isActive(entry: { until: string }, now: Date): boolean {
  return now.getTime() < Date.parse(entry.until);
}

function overrideLayers(overrides: readonly LimitsOverride[], input: ResolveInput): Contribution[] {
  return overrides
    .filter((o) => isActive(o, input.now))
    .filter((o) => selects(o.pools, input.pool) && selects(o.profiles, input.profile) && selects(o.seats, input.seat))
    .map((o) => ({ layer: "override", values: o, tag: `override:${o.decision}` }));
}

function grantLayers(pool: PoolLimits, input: ResolveInput): Contribution[] {
  const lift = pool.lift;
  if (!lift) return [];
  const resetsAt = input.fiveHourResetsAt?.getTime() ?? Number.POSITIVE_INFINITY;
  return (input.grants ?? [])
    .filter((g) => g.pool === input.pool && isActive(g, input.now))
    .filter((g) => input.answeredQuestions?.has(g.question) === true && Date.parse(g.until) <= resetsAt)
    .map((g) => ({
      layer: "grant",
      values: { ceiling_five_hour: Math.min(g.ceiling_five_hour, lift.ceiling_five_hour) },
      tag: `grant:${g.question}`,
    }));
}

function contributions(block: LimitsBlock, pool: PoolLimits, input: ResolveInput): Contribution[] {
  const profile = input.profile === undefined ? undefined : block.profiles[input.profile];
  return [
    { layer: "code", values: LIMIT_DEFAULTS },
    { layer: "defaults", values: block.defaults ?? {} },
    { layer: "pool", values: pool },
    { layer: "profile", values: profile ?? {} },
    { layer: "profile_pool", values: profile?.pools?.[input.pool] ?? {} },
    ...overrideLayers(block.overrides, input),
    ...grantLayers(pool, input),
  ];
}

function fold(layers: readonly Contribution[]) {
  const values: Record<string, unknown> = {};
  const sources = {} as Record<ResolvedField, LimitLayer>;
  const applied = new Set<string>();
  for (const { layer, values: set, tag } of layers) {
    for (const field of LAYERED_FIELDS) {
      if (set[field] === undefined) continue;
      values[field] = set[field];
      sources[field] = layer;
      if (tag) applied.add(tag);
    }
  }
  return { values, sources, applied: [...applied] };
}

function clampAll(values: Record<string, unknown>): ResolvedField[] {
  const clamped: ResolvedField[] = [];
  for (const [field, value] of Object.entries(values)) {
    if (typeof value !== "number") continue;
    const bounded = clampToBounds(field, value);
    if (bounded === value) continue;
    values[field] = bounded;
    clamped.push(field as ResolvedField);
  }
  return clamped;
}

function closedReason(parsed: ParsedLimits, input: ResolveInput): string | null {
  const { pool, profile, seat } = input;
  if (parsed.closedPools[pool] !== undefined) return `pool ${pool} is malformed: ${parsed.closedPools[pool]}`;
  if (parsed.limits.pools[pool] === undefined) return `pool ${pool} has no limits`;
  if (profile !== undefined && parsed.closedProfiles[profile] !== undefined) {
    return `profile ${profile} is malformed: ${parsed.closedProfiles[profile]}`;
  }
  if (seat !== undefined && parsed.closedSeats[seat] !== undefined) {
    return `seat ${seat} is malformed: ${parsed.closedSeats[seat]}`;
  }
  return null;
}

/** A seat cap is a separate stop beside the pool's, so it can only tighten. */
function applySeat(limits: ResolvedLimits, parsed: ParsedLimits, seat: string | undefined): void {
  const caps = seat === undefined ? undefined : parsed.limits.seats[seat];
  if (caps?.per_run_points !== undefined) {
    limits.per_run_points = clampToBounds("per_run_points", caps.per_run_points);
    limits.sources.per_run_points = "seat";
  }
  const day = caps?.per_day_points;
  if (day !== undefined && (limits.per_day_points === null || day < limits.per_day_points)) {
    limits.per_day_points = clampToBounds("per_day_points", day);
    limits.sources.per_day_points = "seat";
  }
}

/** Resolves one pool for one spawn. Pure: `now` and the grants come in, nothing is read. */
export function resolveLimits(parsed: ParsedLimits, input: ResolveInput): ResolveResult {
  const reason = closedReason(parsed, input);
  if (reason !== null) return { open: false, reason };
  const pool = parsed.limits.pools[input.pool]!;
  const profile = input.profile === undefined ? undefined : parsed.limits.profiles[input.profile];
  const { values, sources, applied } = fold(contributions(parsed.limits, pool, input));
  const clamped = clampAll(values);
  const limits = {
    ...(values as Pick<ResolvedLimits, LayeredField>),
    pool: input.pool,
    config_dir: pool.config_dir,
    per_run_points: null,
    lift: pool.lift ?? null,
    band_fallback: profile?.band_fallback ?? null,
    context_tokens: profile?.context_tokens ?? null,
    sources: { ...sources, per_run_points: "code" as LimitLayer },
    applied,
    clamped,
  };
  applySeat(limits, parsed, input.seat);
  return { open: true, limits };
}
