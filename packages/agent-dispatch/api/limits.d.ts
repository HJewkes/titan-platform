import { G as Grant, L as Lift, P as ParsedLimits } from '../parse.js';
export { I as IgnoredEntry, a as Limits, b as LimitsBlock, c as LimitsConfigError, d as LimitsDefaults, e as LimitsOverride, f as PoolLimits, g as ProfileLimits, S as SeatLimits, h as grantSchema, l as liftSchema, i as limitsSchema, o as overrideSchema, p as parseLimits, j as poolSchema, k as profileSchema, s as seatSchema } from '../parse.js';
import 'zod';

/**
 * Layer 1 of the precedence: what a field resolves to when no config layer sets it. Every
 * margin the gate applies is named here so none hides in a gate as a bare constant. A pool
 * must set its own ceiling and reserve, so those two entries only complete the record.
 */
declare const LIMIT_DEFAULTS: {
    readonly human_uses: false;
    readonly ceiling_five_hour: 100;
    readonly reserve_seven_day: 0;
    readonly per_day_points: number | null;
    readonly sonnet_band_points: 10;
    readonly dispatch_seven_day_points: 2;
    readonly dispatch_five_hour_points: 10;
    readonly pick_margin_five_hour: 0;
    readonly present_ceiling_five_hour: 70;
    readonly present_within_minutes: 15;
};
type LayeredField = keyof typeof LIMIT_DEFAULTS;
/** The bounds `resolveLimits` clamps to and `checkLimits` reports against. */
declare const LIMIT_BOUNDS: Partial<Record<LayeredField | "per_run_points", {
    min: number;
    max: number;
}>>;

type LimitLayer = "code" | "defaults" | "pool" | "profile" | "profile_pool" | "override" | "grant" | "seat";
type ResolvedField = LayeredField | "per_run_points";
interface ResolveInput {
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
interface ResolvedLimits {
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
type ResolveResult = {
    open: true;
    limits: ResolvedLimits;
} | {
    open: false;
    reason: string;
};
/** Resolves one pool for one spawn. Pure: `now` and the grants come in, nothing is read. */
declare function resolveLimits(parsed: ParsedLimits, input: ResolveInput): ResolveResult;

type LimitsFindingKind = "invalid_pool" | "invalid_profile" | "invalid_seat" | "ignored_override" | "expired_override" | "unknown_pool" | "unknown_profile" | "unknown_config_dir" | "clamped";
interface LimitsFinding {
    kind: LimitsFindingKind;
    message: string;
}
interface CheckOptions {
    now: Date;
    /** Config dirs that exist on this host, e.g. from anthropic-account's `discoverProfiles()`. */
    knownConfigDirs?: readonly string[];
    /** Agent profile names the dispatcher knows. Without it, profile names are not checked. */
    knownProfiles?: readonly string[];
}
/** Everything about a limits block worth telling the owner, without changing what resolves. */
declare function checkLimits(parsed: ParsedLimits, options: CheckOptions): LimitsFinding[];

interface FiveHourReading {
    fiveHour: number;
    resetsAt: Date;
}
interface LiftQuestion {
    pool: string;
    /** `<pool>:<resets_at>`: one question per pool per five-hour window, recorded as asked by the caller. */
    key: string;
    resetsAt: Date;
    liftTo: number;
    text: string;
}
interface LiftAnswer {
    questionId: string;
    answer: "yes" | "no";
}
declare function liftKey(pool: string, resetsAt: Date): string;
/** The question to ask the owner when a liftable pool reaches its ceiling, or null when none is due. */
declare function liftQuestion(input: {
    limits: ResolvedLimits;
    reading: FiveHourReading;
    asked: ReadonlySet<string>;
}): LiftQuestion | null;
/** The grant a yes writes: the lifted ceiling until the window resets. A no, or no answer, holds. */
declare function grantFromAnswer(question: LiftQuestion, answer: LiftAnswer): Grant | null;

export { type CheckOptions, type FiveHourReading, Grant, LIMIT_BOUNDS, LIMIT_DEFAULTS, type LayeredField, Lift, type LiftAnswer, type LiftQuestion, type LimitLayer, type LimitsFinding, type LimitsFindingKind, ParsedLimits, type ResolveInput, type ResolveResult, type ResolvedField, type ResolvedLimits, checkLimits, grantFromAnswer, liftKey, liftQuestion, resolveLimits };

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
