import { z } from "zod";
import {
  defaultsSchema,
  overrideSchema,
  poolSchema,
  profileSchema,
  seatSchema,
  type Limits,
  type LimitsOverride,
} from "./schema.js";

export class LimitsConfigError extends Error {
  override readonly name = "LimitsConfigError";
}

export type LimitsBlock = Limits & Required<Pick<Limits, "funds" | "profiles" | "seats" | "overrides">>;

export interface IgnoredEntry {
  index: number;
  reason: string;
}

/**
 * A limits block split by scope. A malformed pool, profile or seat is closed by name rather
 * than failing the whole block, so one typo stops only the spawns it governs.
 */
export interface ParsedLimits {
  limits: LimitsBlock;
  closedPools: Record<string, string>;
  closedProfiles: Record<string, string>;
  closedSeats: Record<string, string>;
  ignoredOverrides: IgnoredEntry[];
}

const scoped = z.record(z.string(), z.unknown());

const envelopeSchema = z.strictObject({
  version: z.literal(1),
  defaults: defaultsSchema.optional(),
  pools: scoped,
  funds: z.record(z.string(), z.array(z.string().min(1))).optional(),
  profiles: scoped.optional(),
  seats: scoped.optional(),
  overrides: z.array(z.unknown()).optional(),
});

function splitScope<T>(
  schema: z.ZodType<T>,
  entries: Record<string, unknown> | undefined,
): { valid: Record<string, T>; closed: Record<string, string> } {
  const valid: Record<string, T> = {};
  const closed: Record<string, string> = {};
  for (const [name, value] of Object.entries(entries ?? {})) {
    const result = schema.safeParse(value);
    if (result.success) valid[name] = result.data;
    else closed[name] = z.prettifyError(result.error);
  }
  return { valid, closed };
}

function splitOverrides(entries: unknown[] | undefined) {
  const valid: LimitsOverride[] = [];
  const ignored: IgnoredEntry[] = [];
  (entries ?? []).forEach((value, index) => {
    const result = overrideSchema.safeParse(value);
    if (result.success) valid.push(result.data);
    else ignored.push({ index, reason: z.prettifyError(result.error) });
  });
  return { valid, ignored };
}

/** Throws `LimitsConfigError` only when the envelope itself is unusable; everything inside fails per scope. */
export function parseLimits(raw: unknown): ParsedLimits {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new LimitsConfigError(`limits block refused: ${z.prettifyError(envelope.error)}`);
  }
  const { pools, profiles, seats, overrides, ...rest } = envelope.data;
  const poolParts = splitScope(poolSchema, pools);
  const profileParts = splitScope(profileSchema, profiles);
  const seatParts = splitScope(seatSchema, seats);
  const overrideParts = splitOverrides(overrides);
  return {
    limits: {
      ...rest,
      funds: rest.funds ?? {},
      pools: poolParts.valid,
      profiles: profileParts.valid,
      seats: seatParts.valid,
      overrides: overrideParts.valid,
    },
    closedPools: poolParts.closed,
    closedProfiles: profileParts.closed,
    closedSeats: seatParts.closed,
    ignoredOverrides: overrideParts.ignored,
  };
}
