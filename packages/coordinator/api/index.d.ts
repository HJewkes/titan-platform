import { z } from 'zod';
import { Limits } from '@titan-design/agent-dispatch/limits';

declare const HARD_STOP_CLASSES: readonly ["ruleset-write", "tag-move", "npm-publish", "broker-restart", "launchd-install", "dotfiles-merge", "config-edit", "force-push", "deploy", "spend-money", "third-party-message", "personal-data"];
declare const hardStopClassSchema: z.ZodEnum<{
    "ruleset-write": "ruleset-write";
    "tag-move": "tag-move";
    "npm-publish": "npm-publish";
    "broker-restart": "broker-restart";
    "launchd-install": "launchd-install";
    "dotfiles-merge": "dotfiles-merge";
    "config-edit": "config-edit";
    "force-push": "force-push";
    deploy: "deploy";
    "spend-money": "spend-money";
    "third-party-message": "third-party-message";
    "personal-data": "personal-data";
}>;
declare const charterDefaultsSchema: z.ZodObject<{
    kind_weights: z.ZodRecord<z.ZodString, z.ZodNumber>;
    share_caps: z.ZodRecord<z.ZodString, z.ZodNumber>;
    initiative_decay: z.ZodNumber;
    score_terms: z.ZodObject<{
        severity: z.ZodNumber;
        priority_pct: z.ZodNumber;
        unblocks: z.ZodNumber;
        staleness: z.ZodNumber;
    }, z.core.$loose>;
    severity: z.ZodObject<{
        critical: z.ZodNumber;
        high: z.ZodNumber;
        medium: z.ZodNumber;
        low: z.ZodNumber;
        unset: z.ZodNumber;
    }, z.core.$loose>;
    readiness: z.ZodObject<{
        ready: z.ZodNumber;
        untriaged: z.ZodNumber;
        blocked: z.ZodNumber;
    }, z.core.$loose>;
    size: z.ZodObject<{
        le3: z.ZodNumber;
        le8: z.ZodNumber;
        gt8: z.ZodNumber;
    }, z.core.$loose>;
    stop_short_factor: z.ZodNumber;
    gate_free_bonus: z.ZodOptional<z.ZodNumber>;
    retire_k: z.ZodObject<{
        implementer: z.ZodNumber;
        reviewer: z.ZodNumber;
        planner: z.ZodNumber;
    }, z.core.$loose>;
    teleport_k: z.ZodNumber;
    worktrees_per_repo_per_seat: z.ZodOptional<z.ZodNumber>;
    worktrees_left_free_per_repo: z.ZodNumber;
    stale_pr_days: z.ZodOptional<z.ZodNumber>;
    heartbeat_cron: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const charterPolicySchema: z.ZodObject<{
    schema: z.ZodLiteral<"autonomy-charter/v1">;
    seats: z.ZodArray<z.ZodString>;
    hub: z.ZodString;
    hard_stops: z.ZodArray<z.ZodEnum<{
        "ruleset-write": "ruleset-write";
        "tag-move": "tag-move";
        "npm-publish": "npm-publish";
        "broker-restart": "broker-restart";
        "launchd-install": "launchd-install";
        "dotfiles-merge": "dotfiles-merge";
        "config-edit": "config-edit";
        "force-push": "force-push";
        deploy: "deploy";
        "spend-money": "spend-money";
        "third-party-message": "third-party-message";
        "personal-data": "personal-data";
    }>>;
    defaults: z.ZodObject<{
        kind_weights: z.ZodRecord<z.ZodString, z.ZodNumber>;
        share_caps: z.ZodRecord<z.ZodString, z.ZodNumber>;
        initiative_decay: z.ZodNumber;
        score_terms: z.ZodObject<{
            severity: z.ZodNumber;
            priority_pct: z.ZodNumber;
            unblocks: z.ZodNumber;
            staleness: z.ZodNumber;
        }, z.core.$loose>;
        severity: z.ZodObject<{
            critical: z.ZodNumber;
            high: z.ZodNumber;
            medium: z.ZodNumber;
            low: z.ZodNumber;
            unset: z.ZodNumber;
        }, z.core.$loose>;
        readiness: z.ZodObject<{
            ready: z.ZodNumber;
            untriaged: z.ZodNumber;
            blocked: z.ZodNumber;
        }, z.core.$loose>;
        size: z.ZodObject<{
            le3: z.ZodNumber;
            le8: z.ZodNumber;
            gt8: z.ZodNumber;
        }, z.core.$loose>;
        stop_short_factor: z.ZodNumber;
        gate_free_bonus: z.ZodOptional<z.ZodNumber>;
        retire_k: z.ZodObject<{
            implementer: z.ZodNumber;
            reviewer: z.ZodNumber;
            planner: z.ZodNumber;
        }, z.core.$loose>;
        teleport_k: z.ZodNumber;
        worktrees_per_repo_per_seat: z.ZodOptional<z.ZodNumber>;
        worktrees_left_free_per_repo: z.ZodNumber;
        stale_pr_days: z.ZodOptional<z.ZodNumber>;
        heartbeat_cron: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>;
    title: z.ZodOptional<z.ZodString>;
    created: z.ZodOptional<z.ZodString>;
    owner_seat: z.ZodOptional<z.ZodString>;
    charter_owner: z.ZodOptional<z.ZodString>;
    root: z.ZodOptional<z.ZodString>;
    human_only_initiatives: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$loose>;
declare const charterPolicyErrorSchema: z.ZodObject<{
    code: z.ZodEnum<{
        missing: "missing";
        invalid: "invalid";
    }>;
    path: z.ZodString;
    message: z.ZodString;
}, z.core.$strip>;
type HardStopClass = z.infer<typeof hardStopClassSchema>;
type CharterDefaults = z.infer<typeof charterDefaultsSchema>;
type CharterPolicy = z.infer<typeof charterPolicySchema>;
type CharterPolicyError = z.infer<typeof charterPolicyErrorSchema>;
type CharterPolicyResult = {
    ok: true;
    policy: CharterPolicy;
} | {
    ok: false;
    errors: CharterPolicyError[];
};
/** Validates already-parsed charter front matter; never throws. */
declare function parseCharterPolicy(raw: unknown): CharterPolicyResult;

interface HardStop {
    name: HardStopClass;
    pattern: RegExp;
}
declare const HARD_STOPS: readonly HardStop[];
/**
 * The hard-stop classes whose pattern matches `text`, in `HARD_STOPS` order. Pass `among`
 * (for example the charter's `hard_stops`) to report only those classes.
 */
declare function hardStopsIn(text: string | null | undefined, among?: Iterable<string>): HardStopClass[];

declare const seatRepoSchema: z.ZodObject<{
    path: z.ZodString;
    remote: z.ZodOptional<z.ZodString>;
    default: z.ZodOptional<z.ZodString>;
    initiatives: z.ZodOptional<z.ZodArray<z.ZodString>>;
    git: z.ZodOptional<z.ZodBoolean>;
    live_after: z.ZodOptional<z.ZodString>;
    public: z.ZodOptional<z.ZodBoolean>;
    confidential: z.ZodOptional<z.ZodBoolean>;
    read_only: z.ZodOptional<z.ZodBoolean>;
    local_only: z.ZodOptional<z.ZodBoolean>;
    shared_with: z.ZodOptional<z.ZodArray<z.ZodString>>;
    overflow_until: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const seatSpendSchema: z.ZodObject<{
    per_run_points: z.ZodOptional<z.ZodNumber>;
    per_day_points: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
declare const seatConcurrencySchema: z.ZodObject<{
    implementers: z.ZodNumber;
    reviewers: z.ZodNumber;
    planners: z.ZodNumber;
    analysts: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
declare const seatConfigSchema: z.ZodObject<{
    schema: z.ZodLiteral<"autonomy-seat/v1">;
    name: z.ZodString;
    prefix: z.ZodString;
    pool: z.ZodString;
    config_dir: z.ZodString;
    concurrency: z.ZodObject<{
        implementers: z.ZodNumber;
        reviewers: z.ZodNumber;
        planners: z.ZodNumber;
        analysts: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>;
    spend: z.ZodObject<{
        per_run_points: z.ZodOptional<z.ZodNumber>;
        per_day_points: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>;
    role: z.ZodOptional<z.ZodString>;
    attended: z.ZodOptional<z.ZodBoolean>;
    profile: z.ZodOptional<z.ZodString>;
    surface: z.ZodOptional<z.ZodString>;
    host: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodString>;
    overflow_pool: z.ZodOptional<z.ZodString>;
    pools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    cwd: z.ZodOptional<z.ZodString>;
    heartbeat_cron: z.ZodOptional<z.ZodString>;
    backlog: z.ZodOptional<z.ZodString>;
    initiatives: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    scope_tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    unclaimed_engineering: z.ZodOptional<z.ZodBoolean>;
    task_sources: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    repos: z.ZodOptional<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        remote: z.ZodOptional<z.ZodString>;
        default: z.ZodOptional<z.ZodString>;
        initiatives: z.ZodOptional<z.ZodArray<z.ZodString>>;
        git: z.ZodOptional<z.ZodBoolean>;
        live_after: z.ZodOptional<z.ZodString>;
        public: z.ZodOptional<z.ZodBoolean>;
        confidential: z.ZodOptional<z.ZodBoolean>;
        read_only: z.ZodOptional<z.ZodBoolean>;
        local_only: z.ZodOptional<z.ZodBoolean>;
        shared_with: z.ZodOptional<z.ZodArray<z.ZodString>>;
        overflow_until: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>>;
    deny_repos: z.ZodOptional<z.ZodArray<z.ZodString>>;
    kind_weights: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    share_caps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    excluded_tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    excluded_title_patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    extra_hard_stops: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaults: z.ZodOptional<z.ZodObject<{
        kind_weights: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        share_caps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        initiative_decay: z.ZodOptional<z.ZodNumber>;
        score_terms: z.ZodOptional<z.ZodObject<{
            severity: z.ZodNumber;
            priority_pct: z.ZodNumber;
            unblocks: z.ZodNumber;
            staleness: z.ZodNumber;
        }, z.core.$loose>>;
        severity: z.ZodOptional<z.ZodObject<{
            critical: z.ZodNumber;
            high: z.ZodNumber;
            medium: z.ZodNumber;
            low: z.ZodNumber;
            unset: z.ZodNumber;
        }, z.core.$loose>>;
        readiness: z.ZodOptional<z.ZodObject<{
            ready: z.ZodNumber;
            untriaged: z.ZodNumber;
            blocked: z.ZodNumber;
        }, z.core.$loose>>;
        size: z.ZodOptional<z.ZodObject<{
            le3: z.ZodNumber;
            le8: z.ZodNumber;
            gt8: z.ZodNumber;
        }, z.core.$loose>>;
        stop_short_factor: z.ZodOptional<z.ZodNumber>;
        gate_free_bonus: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        retire_k: z.ZodOptional<z.ZodObject<{
            implementer: z.ZodNumber;
            reviewer: z.ZodNumber;
            planner: z.ZodNumber;
        }, z.core.$loose>>;
        teleport_k: z.ZodOptional<z.ZodNumber>;
        worktrees_per_repo_per_seat: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        worktrees_left_free_per_repo: z.ZodOptional<z.ZodNumber>;
        stale_pr_days: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        heartbeat_cron: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    }, z.core.$loose>>;
    grants_extra: z.ZodOptional<z.ZodArray<z.ZodString>>;
    log: z.ZodOptional<z.ZodString>;
    queue: z.ZodOptional<z.ZodString>;
    dispatch_log: z.ZodOptional<z.ZodString>;
    digest_to: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$loose>;
type SeatConfig = z.infer<typeof seatConfigSchema>;
type SeatRepo = z.infer<typeof seatRepoSchema>;
type SeatSpend = z.infer<typeof seatSpendSchema>;
type SeatConcurrency = z.infer<typeof seatConcurrencySchema>;

interface ResolvedSeatPolicy {
    hard_stops: string[];
    defaults: CharterDefaults;
}
/**
 * One seat's effective policy. A seat may override any charter default, and its top-level
 * `kind_weights` and `share_caps` merge over the charter's key by key. Hard stops only add:
 * the charter's list is kept whole and the seat's `extra_hard_stops` are appended.
 */
declare function resolveSeatPolicy(charter: CharterPolicy, seat: SeatConfig): ResolvedSeatPolicy;

declare const seatEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"spawn">;
    agent: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"retire">;
    agent: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"teleport">;
    successor: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"claim">;
    owner: z.ZodString;
    worktree: z.ZodString;
    patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"release">;
    worktree: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"hold">;
    target: z.ZodString;
    reason: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"unhold">;
    target: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"background">;
    id: z.ZodString;
    command: z.ZodString;
    cwd: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"background-stop">;
    id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"authored">;
    text: z.ZodString;
}, z.core.$strip>], "kind">;
declare const SEAT_EVENT_KINDS: readonly string[];
type SeatEvent = z.infer<typeof seatEventSchema>;

declare const AUTHORED_MAX_CHARS = 1500;
declare const authoredContinuationSchema: z.ZodObject<{
    on: z.ZodEnum<{
        agent: "agent";
        pr: "pr";
        msg: "msg";
        time: "time";
    }>;
    ref: z.ZodString;
    do: z.ZodString;
}, z.core.$strict>;
declare const standingRuleSchema: z.ZodObject<{
    text: z.ZodString;
    source: z.ZodString;
    expires: z.ZodISODate;
}, z.core.$strict>;
declare const openQuestionSchema: z.ZodObject<{
    to: z.ZodString;
    msg_id: z.ZodString;
    text: z.ZodString;
}, z.core.$strict>;
declare const authoredBlockSchema: z.ZodObject<{
    continuations: z.ZodDefault<z.ZodArray<z.ZodObject<{
        on: z.ZodEnum<{
            agent: "agent";
            pr: "pr";
            msg: "msg";
            time: "time";
        }>;
        ref: z.ZodString;
        do: z.ZodString;
    }, z.core.$strict>>>;
    standing_rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        source: z.ZodString;
        expires: z.ZodISODate;
    }, z.core.$strict>>>;
    open_questions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        to: z.ZodString;
        msg_id: z.ZodString;
        text: z.ZodString;
    }, z.core.$strict>>>;
    next_why: z.ZodDefault<z.ZodString>;
}, z.core.$strict>;
type AuthoredContinuation = z.infer<typeof authoredContinuationSchema>;
type StandingRule = z.infer<typeof standingRuleSchema>;
type OpenQuestion = z.infer<typeof openQuestionSchema>;
type AuthoredBlock = z.infer<typeof authoredBlockSchema>;
type AuthoredError = {
    code: "too-long" | "invalid-json" | "missing" | "invalid";
    path: string;
    message: string;
};
type AuthoredResult = {
    ok: true;
    block: AuthoredBlock;
} | {
    ok: false;
    errors: AuthoredError[];
};
/**
 * Validates the seat's authored block from its stored JSON text; never throws.
 * `""` is the cleared block and reads as empty.
 */
declare function parseAuthored(text: string): AuthoredResult;
/**
 * Renders the block as plain-text sections, leaving out empty ones. A standing rule is in
 * force through its `expires` day and is dropped once `now`'s UTC day is past it.
 */
declare function renderAuthored(block: AuthoredBlock, now: Date): string;

declare const seatHoldSchema: z.ZodObject<{
    target: z.ZodString;
    reason: z.ZodString;
}, z.core.$strip>;
declare const seatClaimSchema: z.ZodObject<{
    owner: z.ZodString;
    worktree: z.ZodString;
    patterns: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
declare const seatBackgroundSchema: z.ZodObject<{
    id: z.ZodString;
    command: z.ZodString;
    cwd: z.ZodString;
}, z.core.$strip>;
declare const seatFoldErrorSchema: z.ZodObject<{
    index: z.ZodNumber;
    kind: z.ZodString;
    message: z.ZodString;
}, z.core.$strip>;
declare const seatStateSchema: z.ZodObject<{
    generation: z.ZodNumber;
    agents: z.ZodArray<z.ZodString>;
    holds: z.ZodArray<z.ZodObject<{
        target: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>>;
    claims: z.ZodArray<z.ZodObject<{
        owner: z.ZodString;
        worktree: z.ZodString;
        patterns: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    background: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        command: z.ZodString;
        cwd: z.ZodString;
    }, z.core.$strip>>;
    authored: z.ZodString;
    errors: z.ZodArray<z.ZodObject<{
        index: z.ZodNumber;
        kind: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
    unknownEvents: z.ZodNumber;
}, z.core.$strip>;
type SeatState = z.infer<typeof seatStateSchema>;
type SeatFoldError = z.infer<typeof seatFoldErrorSchema>;
interface SeatFoldOptions {
    /** The host's $TMPDIR, passed in so the fold never reads the environment. */
    tmpdir?: string;
}
declare const emptySeatState: () => SeatState;
/** The first path in a background command that sits in throwaway space, or undefined. */
declare function scratchPathOf(command: string, cwd: string, options?: SeatFoldOptions): string | undefined;
/**
 * Folds a seat's event log into its state. Pure: no clock, fs, env or network. It never throws:
 * an unknown kind is counted and a malformed or refused event is recorded in `errors`, whose
 * `index` counts from the start of this call's `events`, not from any log behind `from`.
 */
declare function foldSeatEvents(events: readonly unknown[], options?: SeatFoldOptions, from?: SeatState): SeatState;

declare const coordinatorOwnerSchema: z.ZodObject<{
    seat: z.ZodString;
    timezone: z.ZodOptional<z.ZodString>;
    day_starts_at: z.ZodOptional<z.ZodString>;
    digest_at: z.ZodOptional<z.ZodArray<z.ZodString>>;
    channels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        console: "console";
        telegram: "telegram";
        matrix: "matrix";
    }>>>;
    decider: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodBoolean;
        question_age_minutes: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>>;
}, z.core.$loose>;
declare const coordinatorSeatSchema: z.ZodObject<{
    kind_weights: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    share_caps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    heartbeat_cron: z.ZodOptional<z.ZodString>;
    defaults: z.ZodOptional<z.ZodObject<{
        kind_weights: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        share_caps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        initiative_decay: z.ZodOptional<z.ZodNumber>;
        score_terms: z.ZodOptional<z.ZodObject<{
            severity: z.ZodNumber;
            priority_pct: z.ZodNumber;
            unblocks: z.ZodNumber;
            staleness: z.ZodNumber;
        }, z.core.$loose>>;
        severity: z.ZodOptional<z.ZodObject<{
            critical: z.ZodNumber;
            high: z.ZodNumber;
            medium: z.ZodNumber;
            low: z.ZodNumber;
            unset: z.ZodNumber;
        }, z.core.$loose>>;
        readiness: z.ZodOptional<z.ZodObject<{
            ready: z.ZodNumber;
            untriaged: z.ZodNumber;
            blocked: z.ZodNumber;
        }, z.core.$loose>>;
        size: z.ZodOptional<z.ZodObject<{
            le3: z.ZodNumber;
            le8: z.ZodNumber;
            gt8: z.ZodNumber;
        }, z.core.$loose>>;
        stop_short_factor: z.ZodOptional<z.ZodNumber>;
        gate_free_bonus: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        retire_k: z.ZodOptional<z.ZodObject<{
            implementer: z.ZodNumber;
            reviewer: z.ZodNumber;
            planner: z.ZodNumber;
        }, z.core.$loose>>;
        teleport_k: z.ZodOptional<z.ZodNumber>;
        worktrees_per_repo_per_seat: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        worktrees_left_free_per_repo: z.ZodOptional<z.ZodNumber>;
        stale_pr_days: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        heartbeat_cron: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    }, z.core.$loose>>;
    initiatives: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    prefix: z.ZodString;
    pool: z.ZodString;
    concurrency: z.ZodObject<{
        implementers: z.ZodNumber;
        reviewers: z.ZodNumber;
        planners: z.ZodNumber;
        analysts: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>;
    spend: z.ZodObject<{
        per_run_points: z.ZodOptional<z.ZodNumber>;
        per_day_points: z.ZodOptional<z.ZodNumber>;
    }, z.core.$loose>;
    role: z.ZodOptional<z.ZodString>;
    attended: z.ZodOptional<z.ZodBoolean>;
    profile: z.ZodOptional<z.ZodString>;
    surface: z.ZodOptional<z.ZodString>;
    host: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodString>;
    overflow_pool: z.ZodOptional<z.ZodString>;
    pools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    cwd: z.ZodOptional<z.ZodString>;
    backlog: z.ZodOptional<z.ZodString>;
    scope_tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    unclaimed_engineering: z.ZodOptional<z.ZodBoolean>;
    task_sources: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    deny_repos: z.ZodOptional<z.ZodArray<z.ZodString>>;
    excluded_tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    excluded_title_patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    extra_hard_stops: z.ZodOptional<z.ZodArray<z.ZodString>>;
    grants_extra: z.ZodOptional<z.ZodArray<z.ZodString>>;
    log: z.ZodOptional<z.ZodString>;
    queue: z.ZodOptional<z.ZodString>;
    dispatch_log: z.ZodOptional<z.ZodString>;
    digest_to: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    repos: z.ZodOptional<z.ZodArray<z.ZodString>>;
    dispatch: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const coordinatorPolicySchema: z.ZodObject<{
    hard_stops: z.ZodArray<z.ZodEnum<{
        "ruleset-write": "ruleset-write";
        "tag-move": "tag-move";
        "npm-publish": "npm-publish";
        "broker-restart": "broker-restart";
        "launchd-install": "launchd-install";
        "dotfiles-merge": "dotfiles-merge";
        "config-edit": "config-edit";
        "force-push": "force-push";
        deploy: "deploy";
        "spend-money": "spend-money";
        "third-party-message": "third-party-message";
        "personal-data": "personal-data";
    }>>;
    hard_stop_repos: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
    human_only_tag: z.ZodOptional<z.ZodString>;
    defaults: z.ZodOptional<z.ZodObject<{
        kind_weights: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        share_caps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        initiative_decay: z.ZodOptional<z.ZodNumber>;
        score_terms: z.ZodOptional<z.ZodObject<{
            severity: z.ZodNumber;
            priority_pct: z.ZodNumber;
            unblocks: z.ZodNumber;
            staleness: z.ZodNumber;
        }, z.core.$loose>>;
        severity: z.ZodOptional<z.ZodObject<{
            critical: z.ZodNumber;
            high: z.ZodNumber;
            medium: z.ZodNumber;
            low: z.ZodNumber;
            unset: z.ZodNumber;
        }, z.core.$loose>>;
        readiness: z.ZodOptional<z.ZodObject<{
            ready: z.ZodNumber;
            untriaged: z.ZodNumber;
            blocked: z.ZodNumber;
        }, z.core.$loose>>;
        size: z.ZodOptional<z.ZodObject<{
            le3: z.ZodNumber;
            le8: z.ZodNumber;
            gt8: z.ZodNumber;
        }, z.core.$loose>>;
        stop_short_factor: z.ZodOptional<z.ZodNumber>;
        gate_free_bonus: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        retire_k: z.ZodOptional<z.ZodObject<{
            implementer: z.ZodNumber;
            reviewer: z.ZodNumber;
            planner: z.ZodNumber;
        }, z.core.$loose>>;
        teleport_k: z.ZodOptional<z.ZodNumber>;
        worktrees_per_repo_per_seat: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        worktrees_left_free_per_repo: z.ZodOptional<z.ZodNumber>;
        stale_pr_days: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        heartbeat_cron: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
declare const coordinatorConfigSchema: z.ZodObject<{
    $schema: z.ZodLiteral<"titan-coordinator/v1">;
    owner: z.ZodObject<{
        seat: z.ZodString;
        timezone: z.ZodOptional<z.ZodString>;
        day_starts_at: z.ZodOptional<z.ZodString>;
        digest_at: z.ZodOptional<z.ZodArray<z.ZodString>>;
        channels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            console: "console";
            telegram: "telegram";
            matrix: "matrix";
        }>>>;
        decider: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodBoolean;
            question_age_minutes: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
    state_dir: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    service: z.ZodOptional<z.ZodObject<{
        label_prefix: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    task_sources: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        kind: z.ZodString;
    }, z.core.$loose>>>;
    repos: z.ZodRecord<z.ZodString, z.ZodObject<{
        path: z.ZodString;
        remote: z.ZodOptional<z.ZodString>;
        default: z.ZodOptional<z.ZodString>;
        initiatives: z.ZodOptional<z.ZodArray<z.ZodString>>;
        git: z.ZodOptional<z.ZodBoolean>;
        live_after: z.ZodOptional<z.ZodString>;
        public: z.ZodOptional<z.ZodBoolean>;
        confidential: z.ZodOptional<z.ZodBoolean>;
        read_only: z.ZodOptional<z.ZodBoolean>;
        local_only: z.ZodOptional<z.ZodBoolean>;
        shared_with: z.ZodOptional<z.ZodArray<z.ZodString>>;
        overflow_until: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    seats: z.ZodRecord<z.ZodString, z.ZodObject<{
        kind_weights: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        share_caps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        heartbeat_cron: z.ZodOptional<z.ZodString>;
        defaults: z.ZodOptional<z.ZodObject<{
            kind_weights: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            share_caps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            initiative_decay: z.ZodOptional<z.ZodNumber>;
            score_terms: z.ZodOptional<z.ZodObject<{
                severity: z.ZodNumber;
                priority_pct: z.ZodNumber;
                unblocks: z.ZodNumber;
                staleness: z.ZodNumber;
            }, z.core.$loose>>;
            severity: z.ZodOptional<z.ZodObject<{
                critical: z.ZodNumber;
                high: z.ZodNumber;
                medium: z.ZodNumber;
                low: z.ZodNumber;
                unset: z.ZodNumber;
            }, z.core.$loose>>;
            readiness: z.ZodOptional<z.ZodObject<{
                ready: z.ZodNumber;
                untriaged: z.ZodNumber;
                blocked: z.ZodNumber;
            }, z.core.$loose>>;
            size: z.ZodOptional<z.ZodObject<{
                le3: z.ZodNumber;
                le8: z.ZodNumber;
                gt8: z.ZodNumber;
            }, z.core.$loose>>;
            stop_short_factor: z.ZodOptional<z.ZodNumber>;
            gate_free_bonus: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            retire_k: z.ZodOptional<z.ZodObject<{
                implementer: z.ZodNumber;
                reviewer: z.ZodNumber;
                planner: z.ZodNumber;
            }, z.core.$loose>>;
            teleport_k: z.ZodOptional<z.ZodNumber>;
            worktrees_per_repo_per_seat: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            worktrees_left_free_per_repo: z.ZodOptional<z.ZodNumber>;
            stale_pr_days: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            heartbeat_cron: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, z.core.$loose>>;
        initiatives: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
        prefix: z.ZodString;
        pool: z.ZodString;
        concurrency: z.ZodObject<{
            implementers: z.ZodNumber;
            reviewers: z.ZodNumber;
            planners: z.ZodNumber;
            analysts: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>;
        spend: z.ZodObject<{
            per_run_points: z.ZodOptional<z.ZodNumber>;
            per_day_points: z.ZodOptional<z.ZodNumber>;
        }, z.core.$loose>;
        role: z.ZodOptional<z.ZodString>;
        attended: z.ZodOptional<z.ZodBoolean>;
        profile: z.ZodOptional<z.ZodString>;
        surface: z.ZodOptional<z.ZodString>;
        host: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        effort: z.ZodOptional<z.ZodString>;
        overflow_pool: z.ZodOptional<z.ZodString>;
        pools: z.ZodOptional<z.ZodArray<z.ZodString>>;
        cwd: z.ZodOptional<z.ZodString>;
        backlog: z.ZodOptional<z.ZodString>;
        scope_tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        unclaimed_engineering: z.ZodOptional<z.ZodBoolean>;
        task_sources: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
        deny_repos: z.ZodOptional<z.ZodArray<z.ZodString>>;
        excluded_tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        excluded_title_patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        extra_hard_stops: z.ZodOptional<z.ZodArray<z.ZodString>>;
        grants_extra: z.ZodOptional<z.ZodArray<z.ZodString>>;
        log: z.ZodOptional<z.ZodString>;
        queue: z.ZodOptional<z.ZodString>;
        dispatch_log: z.ZodOptional<z.ZodString>;
        digest_to: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        repos: z.ZodOptional<z.ZodArray<z.ZodString>>;
        dispatch: z.ZodOptional<z.ZodString>;
    }, z.core.$loose>>;
    limits: z.ZodObject<{
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
    policy: z.ZodObject<{
        hard_stops: z.ZodArray<z.ZodEnum<{
            "ruleset-write": "ruleset-write";
            "tag-move": "tag-move";
            "npm-publish": "npm-publish";
            "broker-restart": "broker-restart";
            "launchd-install": "launchd-install";
            "dotfiles-merge": "dotfiles-merge";
            "config-edit": "config-edit";
            "force-push": "force-push";
            deploy: "deploy";
            "spend-money": "spend-money";
            "third-party-message": "third-party-message";
            "personal-data": "personal-data";
        }>>;
        hard_stop_repos: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        human_only_tag: z.ZodOptional<z.ZodString>;
        defaults: z.ZodOptional<z.ZodObject<{
            kind_weights: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            share_caps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
            initiative_decay: z.ZodOptional<z.ZodNumber>;
            score_terms: z.ZodOptional<z.ZodObject<{
                severity: z.ZodNumber;
                priority_pct: z.ZodNumber;
                unblocks: z.ZodNumber;
                staleness: z.ZodNumber;
            }, z.core.$loose>>;
            severity: z.ZodOptional<z.ZodObject<{
                critical: z.ZodNumber;
                high: z.ZodNumber;
                medium: z.ZodNumber;
                low: z.ZodNumber;
                unset: z.ZodNumber;
            }, z.core.$loose>>;
            readiness: z.ZodOptional<z.ZodObject<{
                ready: z.ZodNumber;
                untriaged: z.ZodNumber;
                blocked: z.ZodNumber;
            }, z.core.$loose>>;
            size: z.ZodOptional<z.ZodObject<{
                le3: z.ZodNumber;
                le8: z.ZodNumber;
                gt8: z.ZodNumber;
            }, z.core.$loose>>;
            stop_short_factor: z.ZodOptional<z.ZodNumber>;
            gate_free_bonus: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            retire_k: z.ZodOptional<z.ZodObject<{
                implementer: z.ZodNumber;
                reviewer: z.ZodNumber;
                planner: z.ZodNumber;
            }, z.core.$loose>>;
            teleport_k: z.ZodOptional<z.ZodNumber>;
            worktrees_per_repo_per_seat: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            worktrees_left_free_per_repo: z.ZodOptional<z.ZodNumber>;
            stale_pr_days: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            heartbeat_cron: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
}, z.core.$loose>;
declare const coordinatorConfigErrorSchema: z.ZodObject<{
    code: z.ZodEnum<{
        missing: "missing";
        invalid: "invalid";
        reference: "reference";
    }>;
    path: z.ZodString;
    message: z.ZodString;
}, z.core.$strip>;
type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
type CoordinatorSeat = z.infer<typeof coordinatorSeatSchema>;
type CoordinatorOwner = z.infer<typeof coordinatorOwnerSchema>;
type CoordinatorPolicy = z.infer<typeof coordinatorPolicySchema>;
type CoordinatorConfigError = z.infer<typeof coordinatorConfigErrorSchema>;
type CoordinatorConfigResult = {
    ok: true;
    config: CoordinatorConfig;
} | {
    ok: false;
    errors: CoordinatorConfigError[];
};
/** Validates a titan-coordinator/v1 document and its cross-references; never throws. */
declare function checkCoordinatorConfig(raw: unknown): CoordinatorConfigResult;

/**
 * Builds a titan-coordinator/v1 document from parsed charter and seat front matter and a
 * limits block. Pure: the caller reads and parses the files, then runs checkCoordinatorConfig.
 */
declare function importAutonomyTree(charter: CharterPolicy, seatFiles: readonly SeatConfig[], limits: Limits): CoordinatorConfig;
/** Renders a document's seats as the seat files they came from, taking config_dir from each seat's pool. */
declare function renderSeatBook(config: CoordinatorConfig): SeatConfig[];

declare const sessionFactsPrSchema: z.ZodObject<{
    repo: z.ZodString;
    number: z.ZodNumber;
    taskId: z.ZodString;
}, z.core.$strip>;
/** One generated session record: a seat generation's work inside a single initiative. */
declare const sessionFactsSchema: z.ZodObject<{
    scope: z.ZodString;
    generation: z.ZodNumber;
    mergedPrs: z.ZodArray<z.ZodObject<{
        repo: z.ZodString;
        number: z.ZodNumber;
        taskId: z.ZodString;
    }, z.core.$strip>>;
    closedTasks: z.ZodArray<z.ZodString>;
    filedTasks: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
type SessionFacts = z.infer<typeof sessionFactsSchema>;
/** What the seat did in one generation; SeatState itself carries no PR or task outcomes. */
interface SeatGenerationActivity {
    mergedPrs: readonly {
        repo: string;
        number: number;
        agent: string;
    }[];
    closedTasks: readonly string[];
    filedTasks: readonly string[];
}
/** Task-id prefix (`TP`) to initiative scope. */
type PrefixScopes = Readonly<Record<string, string>>;
/**
 * Projects one seat generation to a record per initiative it touched, sorted by scope. Work whose
 * prefix or agent name maps to no scope is dropped. Pure: no I/O.
 */
declare function projectSeatGeneration(state: SeatState, activity: SeatGenerationActivity, scopes: PrefixScopes): SessionFacts[];

/** One entry of a coordinator document's revision log; `parent` is the previous revision's `revisionSha`. */
type ConfigRevision = {
    $schema: "titan-coordinator-revision/v1";
    rev: number;
    parent: string | null;
    at: string;
    by: {
        class: "owner-remote" | "owner-terminal" | "import";
        id: string;
    };
    /** sha256 of the action record that authorized the change; an import has none. */
    action?: string | undefined;
    notes?: string[] | undefined;
    document: CoordinatorConfig;
};
declare const configRevisionSchema: z.ZodType<ConfigRevision>;
type ConfigEditResult = {
    ok: true;
    document: CoordinatorConfig;
} | {
    ok: false;
    errors: CoordinatorConfigError[];
};
type DocumentChange = {
    path: string;
    kind: "added" | "removed" | "changed";
    before?: unknown;
    after?: unknown;
};
type ChainError = {
    rev: number;
    code: "invalid" | "sequence" | "parent" | "document";
    message: string;
};
type ChainResult = {
    ok: true;
    head: ConfigRevision;
} | {
    ok: false;
    errors: ChainError[];
};
/** sha256 of a document's canonical JSON: what a reader compares a materialized file against. */
declare function documentSha(document: unknown): string;
/** sha256 of a revision's canonical JSON: the value its child names as `parent`. */
declare function revisionSha(revision: unknown): string;
/**
 * Sets one field of a copy of `doc`; never mutates it and never throws. Refuses a path the schema
 * does not declare, a path whose parent object is absent, and a result that fails `checkCoordinatorConfig`.
 */
declare function applyEdit(doc: CoordinatorConfig, path: string, value: unknown): ConfigEditResult;
/** Leaf-level changes from `before` to `after`, sorted by key; an array is one leaf. */
declare function diffDocuments(before: unknown, after: unknown): DocumentChange[];
/**
 * Checks a revision log oldest first: each entry parses, is numbered by its position, names the
 * previous entry's `revisionSha` as its parent (rev 0 names none), and carries a valid document.
 */
declare function verifyChain(revisions: readonly unknown[]): ChainResult;

export { AUTHORED_MAX_CHARS, type AuthoredBlock, type AuthoredContinuation, type AuthoredError, type AuthoredResult, type ChainError, type ChainResult, type CharterDefaults, type CharterPolicy, type CharterPolicyError, type CharterPolicyResult, type ConfigEditResult, type ConfigRevision, type CoordinatorConfig, type CoordinatorConfigError, type CoordinatorConfigResult, type CoordinatorOwner, type CoordinatorPolicy, type CoordinatorSeat, type DocumentChange, HARD_STOPS, HARD_STOP_CLASSES, type HardStop, type HardStopClass, type OpenQuestion, type PrefixScopes, type ResolvedSeatPolicy, SEAT_EVENT_KINDS, type SeatConcurrency, type SeatConfig, type SeatEvent, type SeatFoldError, type SeatFoldOptions, type SeatGenerationActivity, type SeatRepo, type SeatSpend, type SeatState, type SessionFacts, type StandingRule, applyEdit, authoredBlockSchema, authoredContinuationSchema, charterDefaultsSchema, charterPolicyErrorSchema, charterPolicySchema, checkCoordinatorConfig, configRevisionSchema, coordinatorConfigErrorSchema, coordinatorConfigSchema, coordinatorOwnerSchema, coordinatorPolicySchema, coordinatorSeatSchema, diffDocuments, documentSha, emptySeatState, foldSeatEvents, hardStopClassSchema, hardStopsIn, importAutonomyTree, openQuestionSchema, parseAuthored, parseCharterPolicy, projectSeatGeneration, renderAuthored, renderSeatBook, resolveSeatPolicy, revisionSha, scratchPathOf, seatBackgroundSchema, seatClaimSchema, seatConcurrencySchema, seatConfigSchema, seatEventSchema, seatFoldErrorSchema, seatHoldSchema, seatRepoSchema, seatSpendSchema, seatStateSchema, sessionFactsPrSchema, sessionFactsSchema, standingRuleSchema, verifyChain };
