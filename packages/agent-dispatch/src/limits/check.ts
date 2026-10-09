import { LIMIT_BOUNDS, clampToBounds } from "./defaults.js";
import type { ParsedLimits } from "./parse.js";
import { isActive } from "./resolve.js";

export type LimitsFindingKind =
  | "invalid_pool"
  | "invalid_profile"
  | "invalid_seat"
  | "ignored_override"
  | "expired_override"
  | "unknown_pool"
  | "unknown_profile"
  | "unknown_config_dir"
  | "clamped";

export interface LimitsFinding {
  kind: LimitsFindingKind;
  message: string;
}

export interface CheckOptions {
  now: Date;
  /** Config dirs that exist on this host, e.g. from anthropic-account's `discoverProfiles()`. */
  knownConfigDirs?: readonly string[];
  /** Agent profile names the dispatcher knows. Without it, profile names are not checked. */
  knownProfiles?: readonly string[];
}

function invalidScopes(parsed: ParsedLimits): LimitsFinding[] {
  const scope = (kind: LimitsFindingKind, label: string, closed: Record<string, string>) =>
    Object.entries(closed).map(([name, reason]) => ({ kind, message: `${label} ${name} is closed: ${reason}` }));
  return [
    ...scope("invalid_pool", "pool", parsed.closedPools),
    ...scope("invalid_profile", "profile", parsed.closedProfiles),
    ...scope("invalid_seat", "seat", parsed.closedSeats),
    ...parsed.ignoredOverrides.map(({ index, reason }) => ({
      kind: "ignored_override" as const,
      message: `overrides[${index}] is ignored: ${reason}`,
    })),
  ];
}

function expiredOverrides(parsed: ParsedLimits, now: Date): LimitsFinding[] {
  return parsed.limits.overrides
    .filter((o) => !isActive(o, now))
    .map((o) => ({
      kind: "expired_override",
      message: `override for decision ${o.decision} expired at ${o.until}; delete it`,
    }));
}

function poolReferences(parsed: ParsedLimits): Array<[where: string, pool: string]> {
  const { funds, overrides, seats, profiles } = parsed.limits;
  return [
    ...Object.entries(funds).flatMap(([fund, pools]) => pools.map((p) => [`funds.${fund}`, p] as [string, string])),
    ...overrides.flatMap((o) => (o.pools ?? []).map((p) => [`override ${o.decision}`, p] as [string, string])),
    ...Object.entries(seats).flatMap(([seat, s]) =>
      [s.pool, s.overflow_pool, ...(s.pools ?? [])].flatMap((p) => (p ? [[`seats.${seat}`, p] as [string, string]] : [])),
    ),
    ...Object.entries(profiles).flatMap(([name, p]) =>
      Object.keys(p.pools ?? {}).map((pool) => [`profiles.${name}.pools`, pool] as [string, string]),
    ),
  ];
}

function unknownPools(parsed: ParsedLimits): LimitsFinding[] {
  const known = new Set([...Object.keys(parsed.limits.pools), ...Object.keys(parsed.closedPools)]);
  return poolReferences(parsed)
    .filter(([, pool]) => !known.has(pool))
    .map(([where, pool]) => ({ kind: "unknown_pool", message: `${where} names pool ${pool}, which has no limits` }));
}

function unknownProfiles(parsed: ParsedLimits, knownProfiles: readonly string[] | undefined): LimitsFinding[] {
  if (knownProfiles === undefined) return [];
  const known = new Set(knownProfiles);
  const { profiles, overrides } = parsed.limits;
  const named: Array<[string, string]> = [
    ...Object.keys(profiles).map((p): [string, string] => ["profiles", p]),
    ...Object.entries(profiles).flatMap(([p, v]) => (v.band_fallback ? [[`profiles.${p}.band_fallback`, v.band_fallback] as [string, string]] : [])),
    ...overrides.flatMap((o) => (o.profiles ?? []).map((p): [string, string] => [`override ${o.decision}`, p])),
  ];
  return named
    .filter(([, profile]) => !known.has(profile))
    .map(([where, profile]) => ({ kind: "unknown_profile", message: `${where} names unknown profile ${profile}` }));
}

function unknownConfigDirs(parsed: ParsedLimits, knownConfigDirs: readonly string[] | undefined): LimitsFinding[] {
  if (knownConfigDirs === undefined) return [];
  const known = new Set(knownConfigDirs);
  return Object.entries(parsed.limits.pools)
    .filter(([, pool]) => !known.has(pool.config_dir))
    .map(([name, pool]) => ({
      kind: "unknown_config_dir",
      message: `pool ${name} config_dir ${pool.config_dir} is not a discovered profile`,
    }));
}

function clampsIn(where: string, fields: object): LimitsFinding[] {
  return Object.entries(fields)
    .filter(([field, value]) => field in LIMIT_BOUNDS && typeof value === "number" && clampToBounds(field, value) !== value)
    .map(([field, value]) => ({
      kind: "clamped",
      message: `${where}.${field} ${value} is clamped to ${clampToBounds(field, value as number)}`,
    }));
}

function clamps(parsed: ParsedLimits): LimitsFinding[] {
  const { defaults, pools, profiles, seats, overrides } = parsed.limits;
  return [
    ...clampsIn("defaults", defaults ?? {}),
    ...Object.entries(pools).flatMap(([name, pool]) => clampsIn(`pools.${name}`, pool)),
    ...Object.entries(profiles).flatMap(([name, profile]) => [
      ...clampsIn(`profiles.${name}`, profile),
      ...Object.entries(profile.pools ?? {}).flatMap(([pool, f]) => clampsIn(`profiles.${name}.pools.${pool}`, f)),
    ]),
    ...Object.entries(seats).flatMap(([name, seat]) => clampsIn(`seats.${name}`, seat)),
    ...overrides.flatMap((o) => clampsIn(`override ${o.decision}`, o)),
  ];
}

/** Everything about a limits block worth telling the owner, without changing what resolves. */
export function checkLimits(parsed: ParsedLimits, options: CheckOptions): LimitsFinding[] {
  return [
    ...invalidScopes(parsed),
    ...expiredOverrides(parsed, options.now),
    ...unknownPools(parsed),
    ...unknownProfiles(parsed, options.knownProfiles),
    ...unknownConfigDirs(parsed, options.knownConfigDirs),
    ...clamps(parsed),
  ];
}
