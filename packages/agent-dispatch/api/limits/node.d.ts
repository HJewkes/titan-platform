import { G as Grant, I as IgnoredEntry, P as ParsedLimits } from '../parse.js';
import 'zod';

interface GrantsFile {
    grants: Grant[];
    /** Lift-question keys already asked, so a restart never asks twice in one window. */
    asked: string[];
    ignored: IgnoredEntry[];
}
/**
 * Reads a limits block from a path the caller owns. With `key`, the block is that property of
 * the file (a host config); without it, the file is the block. Any failure throws, so the
 * caller closes every pool.
 */
declare function loadLimits(path: string, options?: {
    key?: string;
}): ParsedLimits;
/** Reads the grants state file. A missing file means no grants yet; a malformed entry is ignored. */
declare function readGrants(path: string): GrantsFile;

export { type GrantsFile, loadLimits, readGrants };

// ./dist/parse.d.ts
import { z } from 'zod';

declare const liftSchema: z.ZodObject<{
    ceiling_five_hour: z.ZodNumber;
    ask: z.ZodLiteral<"owner">;
}, z.core.$strict>;
declare const defaultsSchema: z.ZodObject<{
    human_uses: z.ZodOptional<z.ZodBoolean>;
    present_ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
    present_within_minutes: z.ZodOptional<z.ZodNumber>;
    ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
    reserve_seven_day: z.ZodOptional<z.ZodNumber>;
    per_day_points: z.ZodOptional<z.ZodNumber>;
    sonnet_band_points: z.ZodOptional<z.ZodNumber>;
    dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
    dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
    pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const poolSchema: z.ZodObject<{
    config_dir: z.ZodString;
    human_uses: z.ZodOptional<z.ZodBoolean>;
    ceiling_five_hour: z.ZodNumber;
    reserve_seven_day: z.ZodNumber;
    lift: z.ZodOptional<z.ZodObject<{
        ceiling_five_hour: z.ZodNumber;
        ask: z.ZodLiteral<"owner">;
    }, z.core.$strict>>;
    per_day_points: z.ZodOptional<z.ZodNumber>;
    sonnet_band_points: z.ZodOptional<z.ZodNumber>;
    dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
    dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
    pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const profileSchema: z.ZodObject<{
    pools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
        reserve_seven_day: z.ZodOptional<z.ZodNumber>;
        per_day_points: z.ZodOptional<z.ZodNumber>;
        sonnet_band_points: z.ZodOptional<z.ZodNumber>;
        dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
        dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
        pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    band_fallback: z.ZodOptional<z.ZodString>;
    context_tokens: z.ZodOptional<z.ZodNumber>;
    ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
    reserve_seven_day: z.ZodOptional<z.ZodNumber>;
    per_day_points: z.ZodOptional<z.ZodNumber>;
    sonnet_band_points: z.ZodOptional<z.ZodNumber>;
    dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
    dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
    pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const seatSchema: z.ZodObject<{
    pool: z.ZodOptional<z.ZodString>;
    overflow_pool: z.ZodOptional<z.ZodString>;
    pools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    per_run_points: z.ZodOptional<z.ZodNumber>;
    per_day_points: z.ZodOptional<z.ZodNumber>;
    implementers: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
/** In an override, `per_day_points: null` lifts the cap for the override's lifetime. */
declare const overrideSchema: z.ZodObject<{
    per_day_points: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    pools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    profiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
    seats: z.ZodOptional<z.ZodArray<z.ZodString>>;
    until: z.ZodISODateTime;
    decision: z.ZodString;
    ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
    reserve_seven_day: z.ZodOptional<z.ZodNumber>;
    sonnet_band_points: z.ZodOptional<z.ZodNumber>;
    dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
    dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
    pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
declare const grantSchema: z.ZodObject<{
    pool: z.ZodString;
    ceiling_five_hour: z.ZodNumber;
    until: z.ZodISODateTime;
    question: z.ZodString;
}, z.core.$strict>;
declare const limitsSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    defaults: z.ZodOptional<z.ZodObject<{
        human_uses: z.ZodOptional<z.ZodBoolean>;
        present_ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
        present_within_minutes: z.ZodOptional<z.ZodNumber>;
        ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
        reserve_seven_day: z.ZodOptional<z.ZodNumber>;
        per_day_points: z.ZodOptional<z.ZodNumber>;
        sonnet_band_points: z.ZodOptional<z.ZodNumber>;
        dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
        dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
        pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    pools: z.ZodRecord<z.ZodString, z.ZodObject<{
        config_dir: z.ZodString;
        human_uses: z.ZodOptional<z.ZodBoolean>;
        ceiling_five_hour: z.ZodNumber;
        reserve_seven_day: z.ZodNumber;
        lift: z.ZodOptional<z.ZodObject<{
            ceiling_five_hour: z.ZodNumber;
            ask: z.ZodLiteral<"owner">;
        }, z.core.$strict>>;
        per_day_points: z.ZodOptional<z.ZodNumber>;
        sonnet_band_points: z.ZodOptional<z.ZodNumber>;
        dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
        dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
        pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    funds: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
    profiles: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        pools: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
            reserve_seven_day: z.ZodOptional<z.ZodNumber>;
            per_day_points: z.ZodOptional<z.ZodNumber>;
            sonnet_band_points: z.ZodOptional<z.ZodNumber>;
            dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
            dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
            pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
        band_fallback: z.ZodOptional<z.ZodString>;
        context_tokens: z.ZodOptional<z.ZodNumber>;
        ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
        reserve_seven_day: z.ZodOptional<z.ZodNumber>;
        per_day_points: z.ZodOptional<z.ZodNumber>;
        sonnet_band_points: z.ZodOptional<z.ZodNumber>;
        dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
        dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
        pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    seats: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        pool: z.ZodOptional<z.ZodString>;
        overflow_pool: z.ZodOptional<z.ZodString>;
        pools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        per_run_points: z.ZodOptional<z.ZodNumber>;
        per_day_points: z.ZodOptional<z.ZodNumber>;
        implementers: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    overrides: z.ZodOptional<z.ZodArray<z.ZodObject<{
        per_day_points: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        pools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        profiles: z.ZodOptional<z.ZodArray<z.ZodString>>;
        seats: z.ZodOptional<z.ZodArray<z.ZodString>>;
        until: z.ZodISODateTime;
        decision: z.ZodString;
        ceiling_five_hour: z.ZodOptional<z.ZodNumber>;
        reserve_seven_day: z.ZodOptional<z.ZodNumber>;
        sonnet_band_points: z.ZodOptional<z.ZodNumber>;
        dispatch_seven_day_points: z.ZodOptional<z.ZodNumber>;
        dispatch_five_hour_points: z.ZodOptional<z.ZodNumber>;
        pick_margin_five_hour: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
type Limits = z.infer<typeof limitsSchema>;
type LimitsDefaults = z.infer<typeof defaultsSchema>;
type PoolLimits = z.infer<typeof poolSchema>;
type ProfileLimits = z.infer<typeof profileSchema>;
type SeatLimits = z.infer<typeof seatSchema>;
type LimitsOverride = z.infer<typeof overrideSchema>;
type Lift = z.infer<typeof liftSchema>;
type Grant = z.infer<typeof grantSchema>;

declare class LimitsConfigError extends Error {
    readonly name = "LimitsConfigError";
}
type LimitsBlock = Limits & Required<Pick<Limits, "funds" | "profiles" | "seats" | "overrides">>;
interface IgnoredEntry {
    index: number;
    reason: string;
}
/**
 * A limits block split by scope. A malformed pool, profile or seat is closed by name rather
 * than failing the whole block, so one typo stops only the spawns it governs.
 */
interface ParsedLimits {
    limits: LimitsBlock;
    closedPools: Record<string, string>;
    closedProfiles: Record<string, string>;
    closedSeats: Record<string, string>;
    ignoredOverrides: IgnoredEntry[];
}
/** Throws `LimitsConfigError` only when the envelope itself is unusable; everything inside fails per scope. */
declare function parseLimits(raw: unknown): ParsedLimits;

export { type Grant as G, type IgnoredEntry as I, type Lift as L, type ParsedLimits as P, type SeatLimits as S, type Limits as a, type LimitsBlock as b, LimitsConfigError as c, type LimitsDefaults as d, type LimitsOverride as e, type PoolLimits as f, type ProfileLimits as g, grantSchema as h, limitsSchema as i, poolSchema as j, profileSchema as k, liftSchema as l, overrideSchema as o, parseLimits as p, seatSchema as s };
