import { G as Grant, L as Lift, P as ParsedLimits } from '../parse.js';
export { I as IgnoredEntry, a as Limits, b as LimitsBlock, c as LimitsConfigError, d as LimitsDefaults, e as LimitsOverride, f as PoolLimits, g as ProfileLimits, S as SeatLimits, h as grantSchema, l as liftSchema, i as limitsSchema, o as overrideSchema, p as parseLimits, j as poolSchema, k as profileSchema, s as seatSchema } from '../parse.js';
import { z } from 'zod';

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

declare const roleName: z.ZodEnum<{
    implementers: "implementers";
    reviewers: "reviewers";
    planners: "planners";
}>;
declare const limitsBindingSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"lever">;
    refusal: z.ZodString;
    initiative: z.ZodString;
    task: z.ZodOptional<z.ZodString>;
    lever: z.ZodString;
    value: z.ZodNullable<z.ZodNumber>;
    reading: z.ZodNullable<z.ZodNumber>;
    headroom: z.ZodNullable<z.ZodNumber>;
    source: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"supply">;
    ready: z.ZodNumber;
    mix: z.ZodRecord<z.ZodString, z.ZodNumber>;
}, z.core.$strict>], "kind">;
declare const ledgerOnlyClaimSchema: z.ZodObject<{
    initiative: z.ZodString;
    task: z.ZodString;
    slice: z.ZodOptional<z.ZodString>;
    phase: z.ZodString;
    agentName: z.ZodOptional<z.ZodString>;
    stale: z.ZodNullable<z.ZodString>;
    disposition: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
declare const roleReportSchema: z.ZodObject<{
    cap: z.ZodNumber;
    used: z.ZodNumber;
    live: z.ZodNumber;
    spawning: z.ZodNumber;
    hand: z.ZodNumber;
    ledger: z.ZodNumber;
    handReserve: z.ZodNullable<z.ZodObject<{
        reserve: z.ZodNumber;
        remaining: z.ZodNumber;
    }, z.core.$strict>>;
    ledgerOnly: z.ZodArray<z.ZodObject<{
        initiative: z.ZodString;
        task: z.ZodString;
        slice: z.ZodOptional<z.ZodString>;
        phase: z.ZodString;
        agentName: z.ZodOptional<z.ZodString>;
        stale: z.ZodNullable<z.ZodString>;
        disposition: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
}, z.core.$strict>;
declare const poolReportSchema: z.ZodObject<{
    pool: z.ZodString;
    fiveHour: z.ZodNullable<z.ZodObject<{
        value: z.ZodNumber;
        ageMinutes: z.ZodNumber;
    }, z.core.$strict>>;
    sevenDay: z.ZodNullable<z.ZodObject<{
        value: z.ZodNumber;
        ageMinutes: z.ZodNumber;
    }, z.core.$strict>>;
    band: z.ZodNullable<z.ZodString>;
    pace: z.ZodNullable<z.ZodNumber>;
    reserve: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
declare const blockerSchema: z.ZodObject<{
    pr: z.ZodNumber;
    repo: z.ZodOptional<z.ZodString>;
    refusals: z.ZodNumber;
    slices: z.ZodArray<z.ZodString>;
    files: z.ZodArray<z.ZodString>;
    status: z.ZodEnum<{
        unknown: "unknown";
        stalled: "stalled";
        registered: "registered";
        "not-ours": "not-ours";
    }>;
}, z.core.$strict>;
declare const refusalKindSchema: z.ZodObject<{
    count: z.ZodNumber;
    blockers: z.ZodArray<z.ZodObject<{
        pr: z.ZodNumber;
        repo: z.ZodOptional<z.ZodString>;
        refusals: z.ZodNumber;
        slices: z.ZodArray<z.ZodString>;
        files: z.ZodArray<z.ZodString>;
        status: z.ZodEnum<{
            unknown: "unknown";
            stalled: "stalled";
            registered: "registered";
            "not-ours": "not-ours";
        }>;
    }, z.core.$strict>>;
}, z.core.$strict>;
declare const supplySchema: z.ZodObject<{
    ready: z.ZodNumber;
    waiting: z.ZodNumber;
    seeded: z.ZodNumber;
    readyAgeMinutes: z.ZodObject<{
        p50: z.ZodNullable<z.ZodNumber>;
        p90: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    outOfScope: z.ZodNumber;
}, z.core.$strict>;
declare const worktreesSchema: z.ZodObject<{
    repos: z.ZodRecord<z.ZodString, z.ZodObject<{
        active: z.ZodNumber;
        perRepoPerSeat: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>>;
    ceiling: z.ZodNullable<z.ZodNumber>;
    budget: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
declare const contradictionSchema: z.ZodObject<{
    initiative: z.ZodString;
    task: z.ZodString;
    slice: z.ZodOptional<z.ZodString>;
    class: z.ZodString;
    proposed: z.ZodString;
    since: z.ZodString;
    disposition: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
declare const seatReportSchema: z.ZodObject<{
    binding: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"lever">;
        refusal: z.ZodString;
        initiative: z.ZodString;
        task: z.ZodOptional<z.ZodString>;
        lever: z.ZodString;
        value: z.ZodNullable<z.ZodNumber>;
        reading: z.ZodNullable<z.ZodNumber>;
        headroom: z.ZodNullable<z.ZodNumber>;
        source: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"supply">;
        ready: z.ZodNumber;
        mix: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, z.core.$strict>], "kind">;
    roles: z.ZodRecord<z.ZodEnum<{
        implementers: "implementers";
        reviewers: "reviewers";
        planners: "planners";
    }>, z.ZodObject<{
        cap: z.ZodNumber;
        used: z.ZodNumber;
        live: z.ZodNumber;
        spawning: z.ZodNumber;
        hand: z.ZodNumber;
        ledger: z.ZodNumber;
        handReserve: z.ZodNullable<z.ZodObject<{
            reserve: z.ZodNumber;
            remaining: z.ZodNumber;
        }, z.core.$strict>>;
        ledgerOnly: z.ZodArray<z.ZodObject<{
            initiative: z.ZodString;
            task: z.ZodString;
            slice: z.ZodOptional<z.ZodString>;
            phase: z.ZodString;
            agentName: z.ZodOptional<z.ZodString>;
            stale: z.ZodNullable<z.ZodString>;
            disposition: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    pools: z.ZodArray<z.ZodObject<{
        pool: z.ZodString;
        fiveHour: z.ZodNullable<z.ZodObject<{
            value: z.ZodNumber;
            ageMinutes: z.ZodNumber;
        }, z.core.$strict>>;
        sevenDay: z.ZodNullable<z.ZodObject<{
            value: z.ZodNumber;
            ageMinutes: z.ZodNumber;
        }, z.core.$strict>>;
        band: z.ZodNullable<z.ZodString>;
        pace: z.ZodNullable<z.ZodNumber>;
        reserve: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>;
    refusals: z.ZodRecord<z.ZodString, z.ZodObject<{
        count: z.ZodNumber;
        blockers: z.ZodArray<z.ZodObject<{
            pr: z.ZodNumber;
            repo: z.ZodOptional<z.ZodString>;
            refusals: z.ZodNumber;
            slices: z.ZodArray<z.ZodString>;
            files: z.ZodArray<z.ZodString>;
            status: z.ZodEnum<{
                unknown: "unknown";
                stalled: "stalled";
                registered: "registered";
                "not-ours": "not-ours";
            }>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    planBlocked: z.ZodObject<{
        depBlocked: z.ZodNumber;
        dead: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, z.core.$strict>;
    supply: z.ZodObject<{
        ready: z.ZodNumber;
        waiting: z.ZodNumber;
        seeded: z.ZodNumber;
        readyAgeMinutes: z.ZodObject<{
            p50: z.ZodNullable<z.ZodNumber>;
            p90: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        outOfScope: z.ZodNumber;
    }, z.core.$strict>;
    worktrees: z.ZodObject<{
        repos: z.ZodRecord<z.ZodString, z.ZodObject<{
            active: z.ZodNumber;
            perRepoPerSeat: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>>;
        ceiling: z.ZodNullable<z.ZodNumber>;
        budget: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    contradictions: z.ZodObject<{
        items: z.ZodArray<z.ZodObject<{
            initiative: z.ZodString;
            task: z.ZodString;
            slice: z.ZodOptional<z.ZodString>;
            class: z.ZodString;
            proposed: z.ZodString;
            since: z.ZodString;
            disposition: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        undisposed: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>;
declare const shepherdReportSchema: z.ZodUnion<readonly [z.ZodObject<{
    runs: z.ZodRecord<z.ZodString, z.ZodNumber>;
    held: z.ZodArray<z.ZodObject<{
        run: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strict>>;
    reviews: z.ZodObject<{
        inFlight: z.ZodNumber;
        maxConcurrent: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    error: z.ZodString;
}, z.core.$strict>]>;
declare const limitsReportSchema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    at: z.ZodISODateTime;
    seats: z.ZodRecord<z.ZodString, z.ZodObject<{
        binding: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"lever">;
            refusal: z.ZodString;
            initiative: z.ZodString;
            task: z.ZodOptional<z.ZodString>;
            lever: z.ZodString;
            value: z.ZodNullable<z.ZodNumber>;
            reading: z.ZodNullable<z.ZodNumber>;
            headroom: z.ZodNullable<z.ZodNumber>;
            source: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"supply">;
            ready: z.ZodNumber;
            mix: z.ZodRecord<z.ZodString, z.ZodNumber>;
        }, z.core.$strict>], "kind">;
        roles: z.ZodRecord<z.ZodEnum<{
            implementers: "implementers";
            reviewers: "reviewers";
            planners: "planners";
        }>, z.ZodObject<{
            cap: z.ZodNumber;
            used: z.ZodNumber;
            live: z.ZodNumber;
            spawning: z.ZodNumber;
            hand: z.ZodNumber;
            ledger: z.ZodNumber;
            handReserve: z.ZodNullable<z.ZodObject<{
                reserve: z.ZodNumber;
                remaining: z.ZodNumber;
            }, z.core.$strict>>;
            ledgerOnly: z.ZodArray<z.ZodObject<{
                initiative: z.ZodString;
                task: z.ZodString;
                slice: z.ZodOptional<z.ZodString>;
                phase: z.ZodString;
                agentName: z.ZodOptional<z.ZodString>;
                stale: z.ZodNullable<z.ZodString>;
                disposition: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        pools: z.ZodArray<z.ZodObject<{
            pool: z.ZodString;
            fiveHour: z.ZodNullable<z.ZodObject<{
                value: z.ZodNumber;
                ageMinutes: z.ZodNumber;
            }, z.core.$strict>>;
            sevenDay: z.ZodNullable<z.ZodObject<{
                value: z.ZodNumber;
                ageMinutes: z.ZodNumber;
            }, z.core.$strict>>;
            band: z.ZodNullable<z.ZodString>;
            pace: z.ZodNullable<z.ZodNumber>;
            reserve: z.ZodNullable<z.ZodString>;
        }, z.core.$strict>>;
        refusals: z.ZodRecord<z.ZodString, z.ZodObject<{
            count: z.ZodNumber;
            blockers: z.ZodArray<z.ZodObject<{
                pr: z.ZodNumber;
                repo: z.ZodOptional<z.ZodString>;
                refusals: z.ZodNumber;
                slices: z.ZodArray<z.ZodString>;
                files: z.ZodArray<z.ZodString>;
                status: z.ZodEnum<{
                    unknown: "unknown";
                    stalled: "stalled";
                    registered: "registered";
                    "not-ours": "not-ours";
                }>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        planBlocked: z.ZodObject<{
            depBlocked: z.ZodNumber;
            dead: z.ZodRecord<z.ZodString, z.ZodNumber>;
        }, z.core.$strict>;
        supply: z.ZodObject<{
            ready: z.ZodNumber;
            waiting: z.ZodNumber;
            seeded: z.ZodNumber;
            readyAgeMinutes: z.ZodObject<{
                p50: z.ZodNullable<z.ZodNumber>;
                p90: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>;
            outOfScope: z.ZodNumber;
        }, z.core.$strict>;
        worktrees: z.ZodObject<{
            repos: z.ZodRecord<z.ZodString, z.ZodObject<{
                active: z.ZodNumber;
                perRepoPerSeat: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strict>>;
            ceiling: z.ZodNullable<z.ZodNumber>;
            budget: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
        contradictions: z.ZodObject<{
            items: z.ZodArray<z.ZodObject<{
                initiative: z.ZodString;
                task: z.ZodString;
                slice: z.ZodOptional<z.ZodString>;
                class: z.ZodString;
                proposed: z.ZodString;
                since: z.ZodString;
                disposition: z.ZodNullable<z.ZodString>;
            }, z.core.$strict>>;
            undisposed: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
    }, z.core.$strict>>;
    shepherd: z.ZodNullable<z.ZodUnion<readonly [z.ZodObject<{
        runs: z.ZodRecord<z.ZodString, z.ZodNumber>;
        held: z.ZodArray<z.ZodObject<{
            run: z.ZodString;
            reason: z.ZodString;
        }, z.core.$strict>>;
        reviews: z.ZodObject<{
            inFlight: z.ZodNumber;
            maxConcurrent: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        error: z.ZodString;
    }, z.core.$strict>]>>;
}, z.core.$strict>;
type LimitsReport = z.infer<typeof limitsReportSchema>;
type SeatReport = z.infer<typeof seatReportSchema>;
type LimitsBinding = z.infer<typeof limitsBindingSchema>;
type RoleReport = z.infer<typeof roleReportSchema>;
type LedgerOnlyClaim = z.infer<typeof ledgerOnlyClaimSchema>;
type PoolReport = z.infer<typeof poolReportSchema>;
type RefusalBlocker = z.infer<typeof blockerSchema>;
type RefusalKindReport = z.infer<typeof refusalKindSchema>;
type SupplyReport = z.infer<typeof supplySchema>;
type WorktreesReport = z.infer<typeof worktreesSchema>;
type ContradictionReport = z.infer<typeof contradictionSchema>;
type ShepherdReport = z.infer<typeof shepherdReportSchema>;
type LimitsRole = z.infer<typeof roleName>;

/**
 * What `limitsReport` reads, as plain data. A product adapter maps its planner's dry-run result, pool gate,
 * broker capacity and Shepherd read onto these shapes; the report never reads config, a ledger file or a roster.
 */
/** CC-1097: the lever behind a capacity refusal, with its figures; binary gates carry nulls. */
interface LimitsGateReading {
    lever: string;
    value: number | null;
    reading: number | null;
    headroom: number | null;
    source: string;
}
/** The task a dep-blocked unit waits on, or the open PR a collision names. */
type LimitsBlockerRef = {
    task: string;
    state: string;
} | {
    pr: number;
    repo: string;
};
/** One planner refusal, in the planner's rank order. */
interface LimitsRefusal {
    initiative: string;
    task?: string;
    slice?: string;
    kind: string;
    reason: string;
    gate?: LimitsGateReading;
    blocker?: LimitsBlockerRef;
}
interface LimitsRoleInput {
    cap: number;
    /** The planner's count after planning: held claims that hold a slot, hand spawns and this plan's dispatches. */
    used: number;
    hand: number;
    /** Slots of `cap` kept for hand spawns; absent when the seat keeps none. */
    handReserve?: number;
}
interface LimitsPoolReading {
    value: number;
    readAt: string;
}
interface LimitsPoolInput {
    pool: string;
    fiveHour?: LimitsPoolReading;
    sevenDay?: LimitsPoolReading;
    band?: string;
    pace?: number;
    reserve?: string;
}
interface LimitsWorktreesInput {
    /** The seat's active worktrees per repo. */
    active: Readonly<Record<string, number>>;
    perRepoPerSeat?: number;
    totalCeiling?: number;
    leftFree?: number;
    budget?: number;
}
interface LimitsPrStatus {
    pr: number;
    status: "stalled" | "registered" | "not-ours";
}
interface LimitsSeatInput {
    seat: string;
    refusals: readonly LimitsRefusal[];
    roles: Readonly<Record<LimitsRole, LimitsRoleInput>>;
    /** Queued slices whose dependencies have merged, and those still waiting on a merge. */
    supply: {
        ready: number;
        waiting: number;
        readyAgesMinutes: readonly number[];
    };
    pools: readonly LimitsPoolInput[];
    worktrees: LimitsWorktreesInput;
    /** What the adapter knows of each blocking PR; a PR not listed reports `unknown`. */
    prs?: readonly LimitsPrStatus[];
}
interface LimitsShepherdRun {
    id: string;
    phase: string;
    /** Set when Shepherd holds the run; the run then lists under `held` too. */
    holdReason?: string;
    /** A review dispatched with no verdict yet. */
    reviewInFlight?: boolean;
}
type LimitsShepherdInput = {
    runs: readonly LimitsShepherdRun[];
    maxConcurrent?: number;
} | {
    error: string;
};
interface LimitsPlanInput {
    seats: readonly LimitsSeatInput[];
    /** Agent names the roster shows able to run; a claim whose agent is not here holds no slot. */
    liveAgents: readonly string[];
    /** False until claims carry disposition stamps; then every disposition and `undisposed` read null. */
    dispositionsStamped: boolean;
    shepherd?: LimitsShepherdInput;
}
interface LimitsClaim {
    taskId: string;
    initiative: string;
    slice?: string;
    seat?: string;
    phase: string;
    nextPhase?: string;
    agentName?: string;
    respawn?: unknown;
    stale?: {
        class: string;
        proposed: string;
        since: string;
    };
    disposition?: string;
}
interface LimitsLedger {
    claims: readonly LimitsClaim[];
}
type LimitsClock = () => Date;

/**
 * The v1 `/limits` report: every count is a projection of the planner's dry-run result, the claim ledger and the
 * Shepherd read the caller passes in. Nothing here recounts from config, so it cannot drift from what the tick saw.
 */
declare function limitsReport(plan: LimitsPlanInput, ledger: LimitsLedger, clock: LimitsClock): LimitsReport;

/** The claimed refusal the planner gives a unit the ledger already holds: bookkeeping, reported as `supply.seeded`. */
declare const BOOKKEEPING_REASON = "held in the burndown claim ledger";
/** CC-1097: the refusal kinds a capacity lever produces. */
declare const CAP_KINDS: ReadonlySet<string>;

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

export { BOOKKEEPING_REASON, CAP_KINDS, type CheckOptions, type ContradictionReport, type FiveHourReading, Grant, LIMIT_BOUNDS, LIMIT_DEFAULTS, type LayeredField, type LedgerOnlyClaim, Lift, type LiftAnswer, type LiftQuestion, type LimitLayer, type LimitsBinding, type LimitsBlockerRef, type LimitsClaim, type LimitsClock, type LimitsFinding, type LimitsFindingKind, type LimitsGateReading, type LimitsLedger, type LimitsPlanInput, type LimitsPoolInput, type LimitsPoolReading, type LimitsPrStatus, type LimitsRefusal, type LimitsReport, type LimitsRole, type LimitsRoleInput, type LimitsSeatInput, type LimitsShepherdInput, type LimitsShepherdRun, type LimitsWorktreesInput, ParsedLimits, type PoolReport, type RefusalBlocker, type RefusalKindReport, type ResolveInput, type ResolveResult, type ResolvedField, type ResolvedLimits, type RoleReport, type SeatReport, type ShepherdReport, type SupplyReport, type WorktreesReport, checkLimits, grantFromAnswer, liftKey, liftQuestion, limitsBindingSchema, limitsReport, limitsReportSchema, resolveLimits, seatReportSchema, shepherdReportSchema };

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
