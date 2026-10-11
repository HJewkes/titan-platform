import { Db } from '@titan-design/store-sqlite';
import { z } from 'zod';
import { EpisodeRow, SessionGraph } from '@titan-design/session-graph';
import { ToolFamily, NormalizedSessionObservation } from '@titan-design/session-read';
export { ToolFamily } from '@titan-design/session-read';

/** USD per million tokens. Fitted against 392 `cost-state` rows in the 2026-09-20 audit. */
interface PriceRow {
    /** Matched at a model-id boundary: the id itself, or followed by a -YYYYMMDD or [..] suffix. */
    modelPrefix: string;
    /** ISO date. The latest row at or before a request's timestamp wins. */
    effectiveFrom: string;
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
}
/** Bump on any edit to PRICE_TABLE. The cost report prints it in its footer. */
declare const PRICE_TABLE_VERSION = 3;
declare const PRICE_TABLE: readonly PriceRow[];
/**
 * The longest prefix that matches the model at an id boundary, then the latest row effective at `ts`.
 * Returns null for a model no row covers: an unknown model is unpriced, never defaulted,
 * because a default silently prices a new model at an old model's rate.
 */
declare function findPrice(model: string, ts: string, prices?: readonly PriceRow[]): PriceRow | null;

/** Raw token counts for one API request, as the transcript reports them. */
interface RequestTokens {
    inputTokens?: number;
    cacheReadTokens?: number;
    /** Total cache creation. Used only when the 5m/1h split is absent. */
    cacheCreationTokens?: number;
    cacheCreation5mTokens?: number;
    cacheCreation1hTokens?: number;
    outputTokens?: number;
}
interface PricedRequest {
    inputUsd: number;
    cacheReadUsd: number;
    cacheWrite5mUsd: number;
    cacheWrite1hUsd: number;
    outputUsd: number;
    costUsd: number;
    /** False when no price row covers the model. Every component is then zero. */
    priced: boolean;
}
declare function priceRequest(tokens: RequestTokens, model: string, ts: string, prices?: readonly PriceRow[]): PricedRequest;

type SessionClass = "agent_spawned" | "human_interactive" | "headless_sdk" | "other_headless";
/** Human sessions only. A coordinator drives other agents; an adhoc session does not. */
type HumanRole = "coordinator" | "adhoc";
/** The agent-chat spawn record for a session, as the origin resolver returns it. */
interface SessionOrigin {
    depth: number;
    parentName?: string | null;
    /** "adopted" and "inherited" mark a pane the human took over, not a spawned worker. */
    originKind?: string | null;
    profile?: string | null;
}
interface SessionFacts {
    /** The harness entrypoint. Agent-chat workers and `-p` miners both report "sdk-cli". */
    startType?: string | null;
    origin?: SessionOrigin | null;
    firstUserText?: string | null;
    humanTurnCount?: number;
    inboundKinds?: readonly string[];
    signalKinds?: readonly string[];
}
interface SessionClassification {
    sessionClass: SessionClass;
    reason: string;
    humanRole: HumanRole | null;
}
/**
 * Rule order matters. The origin row wins over `startType` because agent-chat workers
 * run `claude -p` and so report "sdk-cli" exactly like a headless miner does.
 */
declare function classifySession(facts: SessionFacts): SessionClassification;

/** Half-open [lo, hi) in the band's own unit. */
interface Band {
    lo: number;
    hi: number;
    name: string;
}
/** Context size in tokens. From `cf_analyze.py` BANDS. */
declare const CONTEXT_BANDS: readonly Band[];
/** Idle gap in milliseconds. From `cf_analyze.py` IDLE. */
declare const GAP_BANDS: readonly Band[];
/** Null for a value no band covers, so a caller reports the gap instead of inventing one. */
declare function bandOf(value: number, bands: readonly Band[]): string | null;
declare function contextBand(tokens: number): string | null;
declare function gapBand(millis: number): string | null;

/** Initiatives a session's task edges name, with how many edges name each. */
interface TaskInitiative {
    initiative: string;
    edges: number;
}
/**
 * A task edge names the initiative outright, so it wins over the cwd guess. Among several,
 * the most-named initiative wins and a tie goes to the alphabetically first, for a stable report.
 */
declare function sessionInitiative(tasks: readonly TaskInitiative[], cwd: string | null | undefined): string;
/** The cwd rule from `cf_analyze.py` `initiative()`. A worktree under a repo counts as that repo. */
declare function initiativeFromCwd(cwd: string | null | undefined): string;

/** ISO bounds on request `ts`: `since` inclusive, `until` exclusive, null for open. */
interface ReportWindow {
    since: string | null;
    until: string | null;
}
/** An arrival that opens a wake episode: a turn-start record or a mid-loop `queued_command` delivery. */
interface WakeEventRow {
    key: string;
    sessionId: string;
    cause: string;
    delivery: string;
    fromName: string | null;
    /** The channel tag's broadcast flag; for rows extracted before it was stored, the same `msg_id` reached more than one session. */
    broadcast: boolean;
}
/** One agent-chat identity: the name a session carries and how it came to carry it. */
interface AgentNameRow {
    sessionId: string;
    agentName: string;
    originKind: string | null;
    profile: string | null;
}
/** Each agent-chat agent id to the sessions it ran as; the broker log names agents by id. */
declare function readAgentSessions(db: Db): Map<string, string[]>;

declare const ACTION_CLASSES: readonly ["journal-write", "pr-ci-check", "merge", "dispatch", "retire", "task-state", "budget-status", "scorer", "message", "read-investigate", "text-only", "other"];
type ActionClass = (typeof ACTION_CLASSES)[number];
/** One tool call of a request, with the signals session-read extracted for it. */
interface ActionCall {
    tool: string;
    /** Command heads of a Bash call, such as `gh pr checks`. */
    heads?: readonly string[];
    readPaths?: readonly string[];
    writePaths?: readonly string[];
}
/** A rule matches a call when every field it sets matches; list order is the precedence. */
interface ActionRule {
    cls: ActionClass;
    tool?: RegExp;
    head?: RegExp;
    readPath?: RegExp;
    writePath?: RegExp;
}
declare const DEFAULT_ACTION_RULES: readonly ActionRule[];
/** Dispatch is judgment about what to hand out, so it stays out of the mechanical list. */
declare const DEFAULT_MECHANICAL_CLASSES: readonly ActionClass[];
declare function classifyRequest(calls: readonly ActionCall[], rules?: readonly ActionRule[]): ActionClass;

/** A dispatch or a send; with any file write, the first such request ends a session's boot. */
declare const BOOT_TOOL: RegExp;
/** The charter's `teleport_k` and `retire_k` at the time of the TP-499 plan; callers pass their own. */
declare const DEFAULT_CONFIGURED_K: readonly number[];
declare const DEFAULT_K_SWEEP: {
    readonly fromK: 20000;
    readonly toK: 1000000;
    readonly stepK: 5000;
};
declare const DEFAULT_REVIEWER_ROLE = "worker:reviewer";
declare const DEFAULT_STANDING_ROLE = "worker:standing_peer";
declare const DEFAULT_REVIEWER_PRS = 10;
/** The broker logs this when a seat starts handing over; `from` is the outgoing agent id. */
declare const TELEPORT_EVENT = "teleport_started";
declare const sweepResultSchema: z.ZodObject<{
    bestK: z.ZodNullable<z.ZodNumber>;
    bestCostPerRequest: z.ZodNullable<z.ZodNumber>;
    atConfigured: z.ZodArray<z.ZodObject<{
        k: z.ZodNumber;
        costPerRequest: z.ZodNullable<z.ZodNumber>;
        deltaPerRequest: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const paramsSchema: z.ZodObject<{
    bootCostUsd: z.ZodNumber;
    bootFill: z.ZodNumber;
    growthPerRequest: z.ZodNumber;
    readPricePerMTok: z.ZodNumber;
}, z.core.$strip>;
declare const sessionSchema: z.ZodObject<{
    bootCostUsd: z.ZodNumber;
    bootFill: z.ZodNumber;
    growthPerRequest: z.ZodNumber;
    readPricePerMTok: z.ZodNumber;
    sessionId: z.ZodString;
    role: z.ZodString;
    model: z.ZodString;
    requests: z.ZodNumber;
    bootRequests: z.ZodNumber;
    exitFill: z.ZodNumber;
    lastTs: z.ZodString;
    bestK: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
declare const cohortSchema: z.ZodObject<{
    bootCostUsd: z.ZodNumber;
    bootFill: z.ZodNumber;
    growthPerRequest: z.ZodNumber;
    readPricePerMTok: z.ZodNumber;
    halfBoot: z.ZodObject<{
        bestK: z.ZodNullable<z.ZodNumber>;
        bestCostPerRequest: z.ZodNullable<z.ZodNumber>;
        atConfigured: z.ZodArray<z.ZodObject<{
            k: z.ZodNumber;
            costPerRequest: z.ZodNullable<z.ZodNumber>;
            deltaPerRequest: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    bestK: z.ZodNullable<z.ZodNumber>;
    bestCostPerRequest: z.ZodNullable<z.ZodNumber>;
    atConfigured: z.ZodArray<z.ZodObject<{
        k: z.ZodNumber;
        costPerRequest: z.ZodNullable<z.ZodNumber>;
        deltaPerRequest: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    role: z.ZodString;
    model: z.ZodString;
    sessions: z.ZodNumber;
}, z.core.$strip>;
declare const teleportSchema: z.ZodObject<{
    ts: z.ZodString;
    name: z.ZodNullable<z.ZodString>;
    sessionId: z.ZodString;
    role: z.ZodString;
    model: z.ZodString;
    exitFill: z.ZodNumber;
    bestK: z.ZodNullable<z.ZodNumber>;
    overConfigured: z.ZodArray<z.ZodObject<{
        k: z.ZodNumber;
        over: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** `requestsFrom` when the report has no reviewer session at all, so requests per PR is 0. */
declare const POOLED_REVIEWERS = "pooled";
declare const reviewerSchema: z.ZodObject<{
    prs: z.ZodNumber;
    fresh: z.ZodArray<z.ZodObject<{
        role: z.ZodString;
        model: z.ZodString;
        sessions: z.ZodNumber;
        requestsPerPr: z.ZodNumber;
        requestsFrom: z.ZodString;
        requestsFromSessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    standing: z.ZodArray<z.ZodObject<{
        role: z.ZodString;
        model: z.ZodString;
        sessions: z.ZodNumber;
        requestsPerPr: z.ZodNumber;
        requestsFrom: z.ZodString;
        requestsFromSessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const handoffThresholdSchema: z.ZodObject<{
    configuredK: z.ZodArray<z.ZodNumber>;
    sweep: z.ZodObject<{
        fromK: z.ZodNumber;
        toK: z.ZodNumber;
        stepK: z.ZodNumber;
    }, z.core.$strip>;
    cohorts: z.ZodArray<z.ZodObject<{
        bootCostUsd: z.ZodNumber;
        bootFill: z.ZodNumber;
        growthPerRequest: z.ZodNumber;
        readPricePerMTok: z.ZodNumber;
        halfBoot: z.ZodObject<{
            bestK: z.ZodNullable<z.ZodNumber>;
            bestCostPerRequest: z.ZodNullable<z.ZodNumber>;
            atConfigured: z.ZodArray<z.ZodObject<{
                k: z.ZodNumber;
                costPerRequest: z.ZodNullable<z.ZodNumber>;
                deltaPerRequest: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>;
        bestK: z.ZodNullable<z.ZodNumber>;
        bestCostPerRequest: z.ZodNullable<z.ZodNumber>;
        atConfigured: z.ZodArray<z.ZodObject<{
            k: z.ZodNumber;
            costPerRequest: z.ZodNullable<z.ZodNumber>;
            deltaPerRequest: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
        role: z.ZodString;
        model: z.ZodString;
        sessions: z.ZodNumber;
    }, z.core.$strip>>;
    sessions: z.ZodArray<z.ZodObject<{
        bootCostUsd: z.ZodNumber;
        bootFill: z.ZodNumber;
        growthPerRequest: z.ZodNumber;
        readPricePerMTok: z.ZodNumber;
        sessionId: z.ZodString;
        role: z.ZodString;
        model: z.ZodString;
        requests: z.ZodNumber;
        bootRequests: z.ZodNumber;
        exitFill: z.ZodNumber;
        lastTs: z.ZodString;
        bestK: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    unbootedSessions: z.ZodNumber;
    teleports: z.ZodArray<z.ZodObject<{
        ts: z.ZodString;
        name: z.ZodNullable<z.ZodString>;
        sessionId: z.ZodString;
        role: z.ZodString;
        model: z.ZodString;
        exitFill: z.ZodNumber;
        bestK: z.ZodNullable<z.ZodNumber>;
        overConfigured: z.ZodArray<z.ZodObject<{
            k: z.ZodNumber;
            over: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    unmatchedTeleports: z.ZodNumber;
    reviewers: z.ZodObject<{
        prs: z.ZodNumber;
        fresh: z.ZodArray<z.ZodObject<{
            role: z.ZodString;
            model: z.ZodString;
            sessions: z.ZodNumber;
            requestsPerPr: z.ZodNumber;
            requestsFrom: z.ZodString;
            requestsFromSessions: z.ZodNumber;
            costUsd: z.ZodNumber;
        }, z.core.$strip>>;
        standing: z.ZodArray<z.ZodObject<{
            role: z.ZodString;
            model: z.ZodString;
            sessions: z.ZodNumber;
            requestsPerPr: z.ZodNumber;
            requestsFrom: z.ZodString;
            requestsFromSessions: z.ZodNumber;
            costUsd: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
type HandoffThreshold = z.infer<typeof handoffThresholdSchema>;
type HandoffCohort = z.infer<typeof cohortSchema>;
type HandoffSession = z.infer<typeof sessionSchema>;
type HandoffTeleport = z.infer<typeof teleportSchema>;
type ReviewerComparison = z.infer<typeof reviewerSchema>;
type CycleParams = z.infer<typeof paramsSchema>;
type KSweep = HandoffThreshold["sweep"];
/** One main-thread request as the handoff model needs it. */
interface HandoffRequestRow {
    sessionId: string;
    role: string;
    model: string;
    ts: string;
    /** Tokens in context: input, cache reads and cache writes. */
    fill: number;
    tokens: RequestTokens;
    bootAction: boolean;
}
interface TeleportEvent {
    ts: string;
    name: string | null;
    fromAgentId: string;
}
interface HandoffOptions {
    configuredK?: readonly number[];
    sweep?: KSweep;
    reviewerRole?: string;
    /** The role whose boot, fill and growth price a reviewer that stays up across PRs. */
    standingRole?: string;
    reviewerPrs?: number;
    /** Prices every request and the read rate; the package table, not the graph's stored one. */
    prices?: readonly PriceRow[];
}
declare function isBootAction(calls: readonly ActionCall[]): boolean;
/** Broker log lines to teleport starts; any other line, or one that is not JSON, is skipped. */
declare function parseTeleportEvents(lines: Iterable<string>): TeleportEvent[];
/** One cycle boots to f0 and grows g per request up to K: boot/n + read price x mean fill, with n = (K - f0) / g. */
declare function costPerRequest(params: CycleParams, k: number): number | null;
/** The cheapest K on the sweep grid, then each configured K against it. */
declare function sweepK(params: CycleParams, sweep: KSweep, configuredK: readonly number[]): z.infer<typeof sweepResultSchema>;
/** Per role and model: boot cost and fill, fill growth and read price from the requests, then the K sweep. */
declare function handoffThreshold(rows: readonly HandoffRequestRow[], teleports: readonly TeleportEvent[], agentSessions: ReadonlyMap<string, readonly string[]>, options?: HandoffOptions): HandoffThreshold;

/**
 * Narrows a report to some sessions. Every field left out matches all, and fields combine with AND.
 * Compactions and coverage stay window-wide: the graph does not key them to a request.
 */
interface ReportScope {
    sessionIds?: readonly string[];
    /** Keeps sessions whose agent-chat agent name starts with it. */
    agentPrefix?: string;
    /** Report roles, as `byRole` names them. */
    roles?: readonly string[];
}
/** A predicate over a request's session and role; with no scope every request passes. */
declare function scopeFilter(db: Db, scope?: ReportScope): (row: {
    sessionId: string;
    role: string;
}) => boolean;

declare const bucketSchema$1: z.ZodObject<{
    key: z.ZodString;
    requests: z.ZodNumber;
    sessions: z.ZodNumber;
    costUsd: z.ZodNumber;
}, z.core.$strip>;
declare const cellSchema: z.ZodObject<{
    wakeCause: z.ZodString;
    gapBand: z.ZodString;
    requests: z.ZodNumber;
    costUsd: z.ZodNumber;
}, z.core.$strip>;
declare const TOKEN_CLASSES: readonly ["input", "cache_read", "cache_write_5m", "cache_write_1h", "output"];
type TokenClass = (typeof TOKEN_CLASSES)[number];
declare const costReportSchema: z.ZodObject<{
    window: z.ZodObject<{
        since: z.ZodNullable<z.ZodString>;
        until: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    priceTableVersion: z.ZodNullable<z.ZodNumber>;
    totals: z.ZodObject<{
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
        unpricedRequests: z.ZodNumber;
    }, z.core.$strip>;
    byTokenClass: z.ZodArray<z.ZodObject<{
        tokenClass: z.ZodEnum<{
            output: "output";
            input: "input";
            cache_read: "cache_read";
            cache_write_5m: "cache_write_5m";
            cache_write_1h: "cache_write_1h";
        }>;
        tokens: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    byAccount: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    byModel: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    byClass: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    byRole: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    byAction: z.ZodArray<z.ZodObject<{
        role: z.ZodString;
        buckets: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            requests: z.ZodNumber;
            sessions: z.ZodNumber;
            costUsd: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    mechanicalShare: z.ZodObject<{
        classes: z.ZodArray<z.ZodEnum<{
            "journal-write": "journal-write";
            "pr-ci-check": "pr-ci-check";
            merge: "merge";
            dispatch: "dispatch";
            retire: "retire";
            "task-state": "task-state";
            "budget-status": "budget-status";
            scorer: "scorer";
            message: "message";
            "read-investigate": "read-investigate";
            "text-only": "text-only";
            other: "other";
        }>>;
        costUsd: z.ZodNumber;
        share: z.ZodNumber;
        byRole: z.ZodArray<z.ZodObject<{
            role: z.ZodString;
            costUsd: z.ZodNumber;
            share: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    byEpisodeCount: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    byInitiative: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    byContextBand: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    byWakeCause: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        requests: z.ZodNumber;
        sessions: z.ZodNumber;
        costUsd: z.ZodNumber;
        midLoopRequests: z.ZodNumber;
        midLoopCostUsd: z.ZodNumber;
        parts: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            requests: z.ZodNumber;
            sessions: z.ZodNumber;
            costUsd: z.ZodNumber;
            midLoopRequests: z.ZodNumber;
            midLoopCostUsd: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    wakeEpisodes: z.ZodObject<{
        unattributed: z.ZodObject<{
            requests: z.ZodNumber;
            costUsd: z.ZodNumber;
        }, z.core.$strip>;
        byCause: z.ZodArray<z.ZodObject<{
            midLoopEpisodes: z.ZodNumber;
            requestsPerEpisode: z.ZodNumber;
            costPerEpisode: z.ZodNumber;
            byFrom: z.ZodArray<z.ZodObject<{
                episodes: z.ZodNumber;
                requests: z.ZodNumber;
                costUsd: z.ZodNumber;
                noActionEpisodes: z.ZodNumber;
                noActionCostUsd: z.ZodNumber;
                key: z.ZodEnum<{
                    broadcast: "broadcast";
                    seat: "seat";
                    agent: "agent";
                    broker: "broker";
                    none: "none";
                }>;
            }, z.core.$strip>>;
            episodes: z.ZodNumber;
            requests: z.ZodNumber;
            costUsd: z.ZodNumber;
            noActionEpisodes: z.ZodNumber;
            noActionCostUsd: z.ZodNumber;
            key: z.ZodString;
        }, z.core.$strip>>;
        pairs: z.ZodArray<z.ZodObject<{
            episodes: z.ZodNumber;
            requests: z.ZodNumber;
            costUsd: z.ZodNumber;
            noActionEpisodes: z.ZodNumber;
            noActionCostUsd: z.ZodNumber;
            from: z.ZodString;
            fromKind: z.ZodEnum<{
                broadcast: "broadcast";
                seat: "seat";
                agent: "agent";
                broker: "broker";
                none: "none";
            }>;
            to: z.ZodString;
        }, z.core.$strip>>;
        episodes: z.ZodNumber;
        requests: z.ZodNumber;
        costUsd: z.ZodNumber;
        noActionEpisodes: z.ZodNumber;
        noActionCostUsd: z.ZodNumber;
        roles: z.ZodArray<z.ZodString>;
        noActionClasses: z.ZodArray<z.ZodEnum<{
            "journal-write": "journal-write";
            "pr-ci-check": "pr-ci-check";
            merge: "merge";
            dispatch: "dispatch";
            retire: "retire";
            "task-state": "task-state";
            "budget-status": "budget-status";
            scorer: "scorer";
            message: "message";
            "read-investigate": "read-investigate";
            "text-only": "text-only";
            other: "other";
        }>>;
    }, z.core.$strip>;
    handoffThreshold: z.ZodObject<{
        configuredK: z.ZodArray<z.ZodNumber>;
        sweep: z.ZodObject<{
            fromK: z.ZodNumber;
            toK: z.ZodNumber;
            stepK: z.ZodNumber;
        }, z.core.$strip>;
        cohorts: z.ZodArray<z.ZodObject<{
            bootCostUsd: z.ZodNumber;
            bootFill: z.ZodNumber;
            growthPerRequest: z.ZodNumber;
            readPricePerMTok: z.ZodNumber;
            halfBoot: z.ZodObject<{
                bestK: z.ZodNullable<z.ZodNumber>;
                bestCostPerRequest: z.ZodNullable<z.ZodNumber>;
                atConfigured: z.ZodArray<z.ZodObject<{
                    k: z.ZodNumber;
                    costPerRequest: z.ZodNullable<z.ZodNumber>;
                    deltaPerRequest: z.ZodNullable<z.ZodNumber>;
                }, z.core.$strip>>;
            }, z.core.$strip>;
            bestK: z.ZodNullable<z.ZodNumber>;
            bestCostPerRequest: z.ZodNullable<z.ZodNumber>;
            atConfigured: z.ZodArray<z.ZodObject<{
                k: z.ZodNumber;
                costPerRequest: z.ZodNullable<z.ZodNumber>;
                deltaPerRequest: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>>;
            role: z.ZodString;
            model: z.ZodString;
            sessions: z.ZodNumber;
        }, z.core.$strip>>;
        sessions: z.ZodArray<z.ZodObject<{
            bootCostUsd: z.ZodNumber;
            bootFill: z.ZodNumber;
            growthPerRequest: z.ZodNumber;
            readPricePerMTok: z.ZodNumber;
            sessionId: z.ZodString;
            role: z.ZodString;
            model: z.ZodString;
            requests: z.ZodNumber;
            bootRequests: z.ZodNumber;
            exitFill: z.ZodNumber;
            lastTs: z.ZodString;
            bestK: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
        unbootedSessions: z.ZodNumber;
        teleports: z.ZodArray<z.ZodObject<{
            ts: z.ZodString;
            name: z.ZodNullable<z.ZodString>;
            sessionId: z.ZodString;
            role: z.ZodString;
            model: z.ZodString;
            exitFill: z.ZodNumber;
            bestK: z.ZodNullable<z.ZodNumber>;
            overConfigured: z.ZodArray<z.ZodObject<{
                k: z.ZodNumber;
                over: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        unmatchedTeleports: z.ZodNumber;
        reviewers: z.ZodObject<{
            prs: z.ZodNumber;
            fresh: z.ZodArray<z.ZodObject<{
                role: z.ZodString;
                model: z.ZodString;
                sessions: z.ZodNumber;
                requestsPerPr: z.ZodNumber;
                requestsFrom: z.ZodString;
                requestsFromSessions: z.ZodNumber;
                costUsd: z.ZodNumber;
            }, z.core.$strip>>;
            standing: z.ZodArray<z.ZodObject<{
                role: z.ZodString;
                model: z.ZodString;
                sessions: z.ZodNumber;
                requestsPerPr: z.ZodNumber;
                requestsFrom: z.ZodString;
                requestsFromSessions: z.ZodNumber;
                costUsd: z.ZodNumber;
            }, z.core.$strip>>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    wakeCauseByGapBand: z.ZodArray<z.ZodObject<{
        wakeCause: z.ZodString;
        gapBand: z.ZodString;
        requests: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    coldRebuild: z.ZodObject<{
        requests: z.ZodNumber;
        costUsd: z.ZodNumber;
        byGapBandAndCause: z.ZodArray<z.ZodObject<{
            wakeCause: z.ZodString;
            gapBand: z.ZodString;
            requests: z.ZodNumber;
            costUsd: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    compactions: z.ZodObject<{
        total: z.ZodNumber;
        manual: z.ZodNumber;
        auto: z.ZodNumber;
        midLoop: z.ZodNumber;
        droppedTokens: z.ZodNumber;
    }, z.core.$strip>;
    topSessions: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        sessionClass: z.ZodString;
        role: z.ZodString;
        initiative: z.ZodString;
        account: z.ZodString;
        requests: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    unpricedModels: z.ZodArray<z.ZodObject<{
        model: z.ZodString;
        requests: z.ZodNumber;
        tokens: z.ZodNumber;
    }, z.core.$strip>>;
    coverage: z.ZodObject<{
        transcriptsIndexed: z.ZodNumber;
        transcriptsDiscovered: z.ZodNullable<z.ZodNumber>;
        facetBacklog: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
type CostReport = z.infer<typeof costReportSchema>;
type CostBucket = z.infer<typeof bucketSchema$1>;
type WakeCauseBucket = CostReport["byWakeCause"][number];
type WakeGapCell = z.infer<typeof cellSchema>;
type RoleActions = CostReport["byAction"][number];
type MechanicalShare = CostReport["mechanicalShare"];
interface CostReportOptions {
    /** ISO timestamp or date, inclusive. Overrides `days`. */
    since?: string;
    /** ISO timestamp or date, exclusive. */
    until?: string;
    /** Window length ending at `until`, or at `now` when `until` is absent. */
    days?: number;
    now?: Date;
    /** Sessions listed in `topSessions`. */
    top?: number;
    /** Transcripts the caller discovered on disk; the graph cannot know this. */
    transcriptsDiscovered?: number;
    /** The extraction version an audit facet must reach to count as current. */
    facetVersion?: number;
    /** Action rules in precedence order; seat-specific rules belong in the caller's config. */
    actionRules?: readonly ActionRule[];
    /** Action classes counted as mechanical in `mechanicalShare`. */
    mechanicalClasses?: readonly ActionClass[];
    /** Report roles whose wakes `wakeEpisodes` cuts into episodes. */
    episodeRoles?: readonly string[];
    /** A wake is no-action when every one of its requests falls in these action classes. */
    noActionClasses?: readonly ActionClass[];
    /** The broker log's lines, read by the caller; its teleport starts give each handoff's exit fill. */
    brokerLogLines?: () => Iterable<string>;
    handoff?: HandoffOptions;
    /** Narrows every request-keyed field to some sessions; absent means all. */
    scope?: ReportScope;
}
/** Reads the graph and never writes it, so a read-only connection is enough. */
declare function costReport(db: Db, options?: CostReportOptions): CostReport;

/** The tool calls each request in the window issued, keyed by `request_id`; a request with none is absent. */
declare function readRequestToolCalls(db: Db, window: ReportWindow): Map<string, ActionCall[]>;

declare const WAKE_FROM_KINDS: readonly ["seat", "agent", "broadcast", "broker", "none"];
type WakeFromKind = (typeof WAKE_FROM_KINDS)[number];
/** Report roles whose wakes are cut into episodes: a human coordinator and a spawned coordinator seat. */
declare const DEFAULT_EPISODE_ROLES: readonly string[];
/** A wake whose requests only read, answer in text, or call tools no rule names changed nothing outside the session. */
declare const DEFAULT_NO_ACTION_CLASSES: readonly ActionClass[];
declare const AGENT_LIFECYCLE = "agent_lifecycle";
declare const causeSchema: z.ZodObject<{
    midLoopEpisodes: z.ZodNumber;
    requestsPerEpisode: z.ZodNumber;
    costPerEpisode: z.ZodNumber;
    byFrom: z.ZodArray<z.ZodObject<{
        episodes: z.ZodNumber;
        requests: z.ZodNumber;
        costUsd: z.ZodNumber;
        noActionEpisodes: z.ZodNumber;
        noActionCostUsd: z.ZodNumber;
        key: z.ZodEnum<{
            broadcast: "broadcast";
            seat: "seat";
            agent: "agent";
            broker: "broker";
            none: "none";
        }>;
    }, z.core.$strip>>;
    episodes: z.ZodNumber;
    requests: z.ZodNumber;
    costUsd: z.ZodNumber;
    noActionEpisodes: z.ZodNumber;
    noActionCostUsd: z.ZodNumber;
    key: z.ZodString;
}, z.core.$strip>;
declare const pairSchema: z.ZodObject<{
    episodes: z.ZodNumber;
    requests: z.ZodNumber;
    costUsd: z.ZodNumber;
    noActionEpisodes: z.ZodNumber;
    noActionCostUsd: z.ZodNumber;
    from: z.ZodString;
    fromKind: z.ZodEnum<{
        broadcast: "broadcast";
        seat: "seat";
        agent: "agent";
        broker: "broker";
        none: "none";
    }>;
    to: z.ZodString;
}, z.core.$strip>;
declare const wakeEpisodesSchema: z.ZodObject<{
    unattributed: z.ZodObject<{
        requests: z.ZodNumber;
        costUsd: z.ZodNumber;
    }, z.core.$strip>;
    byCause: z.ZodArray<z.ZodObject<{
        midLoopEpisodes: z.ZodNumber;
        requestsPerEpisode: z.ZodNumber;
        costPerEpisode: z.ZodNumber;
        byFrom: z.ZodArray<z.ZodObject<{
            episodes: z.ZodNumber;
            requests: z.ZodNumber;
            costUsd: z.ZodNumber;
            noActionEpisodes: z.ZodNumber;
            noActionCostUsd: z.ZodNumber;
            key: z.ZodEnum<{
                broadcast: "broadcast";
                seat: "seat";
                agent: "agent";
                broker: "broker";
                none: "none";
            }>;
        }, z.core.$strip>>;
        episodes: z.ZodNumber;
        requests: z.ZodNumber;
        costUsd: z.ZodNumber;
        noActionEpisodes: z.ZodNumber;
        noActionCostUsd: z.ZodNumber;
        key: z.ZodString;
    }, z.core.$strip>>;
    pairs: z.ZodArray<z.ZodObject<{
        episodes: z.ZodNumber;
        requests: z.ZodNumber;
        costUsd: z.ZodNumber;
        noActionEpisodes: z.ZodNumber;
        noActionCostUsd: z.ZodNumber;
        from: z.ZodString;
        fromKind: z.ZodEnum<{
            broadcast: "broadcast";
            seat: "seat";
            agent: "agent";
            broker: "broker";
            none: "none";
        }>;
        to: z.ZodString;
    }, z.core.$strip>>;
    episodes: z.ZodNumber;
    requests: z.ZodNumber;
    costUsd: z.ZodNumber;
    noActionEpisodes: z.ZodNumber;
    noActionCostUsd: z.ZodNumber;
    roles: z.ZodArray<z.ZodString>;
    noActionClasses: z.ZodArray<z.ZodEnum<{
        "journal-write": "journal-write";
        "pr-ci-check": "pr-ci-check";
        merge: "merge";
        dispatch: "dispatch";
        retire: "retire";
        "task-state": "task-state";
        "budget-status": "budget-status";
        scorer: "scorer";
        message: "message";
        "read-investigate": "read-investigate";
        "text-only": "text-only";
        other: "other";
    }>>;
}, z.core.$strip>;
type WakeEpisodes = z.infer<typeof wakeEpisodesSchema>;
type WakeCauseEpisodes = z.infer<typeof causeSchema>;
type WakePair = z.infer<typeof pairSchema>;
/** One request as the episode view needs it. */
interface EpisodeRequestRow {
    costUsd: number;
    action: ActionClass;
    eventKey: string | null;
}
interface WakeEpisode {
    key: string;
    cause: string;
    midLoop: boolean;
    fromKind: WakeFromKind;
    from: string;
    to: string;
    requests: number;
    costUsd: number;
    noAction: boolean;
}
interface EpisodeNames {
    seats: ReadonlySet<string>;
    /** Each receiving session's agent-chat name. */
    receivers: ReadonlyMap<string, string>;
}
/** A seat is a name some top-level session carries, or one a coordinator profile was spawned under. */
declare function episodeNames(rows: readonly AgentNameRow[]): EpisodeNames;
/** Each event with the requests that followed it, flagged no-action when every request's class is listed. */
declare function buildWakeEpisodes(events: readonly WakeEventRow[], requests: readonly EpisodeRequestRow[], names: EpisodeNames, noActionClasses: readonly ActionClass[]): WakeEpisode[];
declare function summarizeWakeEpisodes(episodes: readonly WakeEpisode[], requests: readonly EpisodeRequestRow[], roles: readonly string[], noActionClasses: readonly ActionClass[]): WakeEpisodes;

/** Two rule sets on purpose (design section 18): workers segment by assignment, coordinators by work phase. */
type Heuristic = "worker-v1" | "coordinator-v1";
declare const HEURISTIC_VERSIONS: Readonly<Record<Heuristic, number>>;
interface EpisodeRequest {
    offset: number;
    ts: string;
    transcriptId: number;
    contextTokens: number;
    wakeCause: string | null;
}
interface EpisodeInbound {
    offset: number;
    ts: string;
    transcriptId: number;
    cause: string;
}
interface EpisodeSignal {
    offset: number;
    ts: string;
    transcriptId: number;
    signal: string;
}
interface EpisodeInput {
    requests: readonly EpisodeRequest[];
    inbounds: readonly EpisodeInbound[];
    signals: readonly EpisodeSignal[];
    /** An agent-chat spawn has a brief; anything else opens at `session_start`. */
    spawned: boolean;
}
declare const IDLE_GAP_MS: number;
declare const CHANNEL_CLUSTER_MS: number;
declare const COORDINATOR_MIN_EPISODE_REQUESTS = 8;
declare const COORDINATOR_MERGE_DEDUPE_REQUESTS = 15;
declare const COORDINATOR_WAVE_QUIET_REQUESTS = 15;
declare const CONTEXT_RESET_TOKENS = 20000;
/** Pure: the same rows always cut the same way. Rows come back in episode order. */
declare function buildEpisodes(input: EpisodeInput, heuristic: Heuristic): EpisodeRow[];
/** Workers are segmented; human sessions get the coordinator rule; headless runs get none. */
declare function heuristicFor(sessionClass: SessionClass): Heuristic | null;
/** The worker report's `n_assignments`: episodes an assignment opened, which is what the standing-peer overlay counts. */
declare function assignmentCount(rows: readonly Pick<EpisodeRow, "openedBy">[]): number;
declare function readEpisodeInput(db: Db, sessionId: string, spawned: boolean): EpisodeInput;
interface WrittenEpisodes {
    sessionId: string;
    heuristic: Heuristic;
    episodes: number;
}
/** Segments each session with its class's heuristic and replaces that heuristic's rows. Headless sessions are skipped. */
declare function writeEpisodes(graph: SessionGraph, sessionIds: readonly string[]): WrittenEpisodes[];
/**
 * Sessions `writeEpisodes` would change, most recently active first: the class has a heuristic and
 * the last main-thread request runs past that heuristic's stored episodes, or none are stored. A
 * session with no main-thread request is never stale, since segmenting it writes nothing. Timestamps
 * compare parsed, because a worker episode can end on an inbound whose ISO form differs from the request's.
 */
declare function staleEpisodeSessions(db: Db, ids?: readonly string[]): string[];

/** worker-v1's role vocabulary, from worker-forensics-report.md section 2. */
type WorkerRole = "implementer" | "reviewer" | "researcher" | "planner" | "coordinator" | "standing_peer" | "unknown";
/** Spawn profile to role, as the worker report's table (wf_analyze.py:79-91) maps it. */
declare const PROFILE_ROLES: Readonly<Record<string, WorkerRole>>;
declare const STANDING_PEER_MIN_HOURS = 12;
declare const STANDING_PEER_MIN_ASSIGNMENTS = 2;
interface WorkerFacts {
    profile?: string | null;
    /** First request to last request, over the whole session rather than a report window. */
    lifetimeMs: number;
    /** worker-v1 episodes opened by an assignment (the brief or a channel follow-up), not by an idle gap. */
    assignments: number;
}
declare function roleFromProfile(profile: string | null | undefined): WorkerRole;
/** A worker that outlives its first assignment is a standing peer whatever it was spawned as (wf_analyze.py:94-103). */
declare function workerRole(facts: WorkerFacts): WorkerRole;
/** The report's role key: `coordinator` or `adhoc` for humans, `worker:<role>` for spawned agents, else the class. */
declare function sessionRole(classification: SessionClassification, worker: WorkerFacts): string;

declare const LIST_PRICE_CAVEAT = "List prices, not a bill: the accounts behind these sessions may run on subscription plans. Rankings hold; the absolute figure is not what you paid.";
/** The same report as plain-text tables, one section per report field, caveat and footer last. */
declare function renderCostReportText(report: CostReport): string;
/** The report's sections a caller may render alone, keyed by the field each one shows. */
declare const COST_REPORT_SECTIONS: {
    readonly byRole: (report: CostReport) => string;
    readonly byAction: (report: CostReport) => string;
    readonly mechanicalShare: (report: CostReport) => string;
    readonly byWakeCause: (report: CostReport) => string;
    readonly wakeEpisodes: (report: CostReport) => string;
    readonly wakePairs: (report: CostReport) => string;
    readonly handoff: (report: CostReport) => string;
    readonly teleports: (report: CostReport) => string;
    readonly reviewers: (report: CostReport) => string;
};
type CostReportSection = keyof typeof COST_REPORT_SECTIONS;
/** Some sections of the report under its header, with the caveat and footer last as in the full text. */
declare function renderCostReportSections(report: CostReport, sections: readonly CostReportSection[]): string;

/** Gap bands past a 5-minute TTL: the next request finds the cache gone. */
declare const REBUILD_GAP_BANDS: readonly string[];
/** One request as the TTL what-if needs it. */
interface TtlRequestRow {
    sessionId: string;
    role: string;
    profile: string;
    model: string;
    ts: string;
    cacheReadTokens: number;
    cacheWrite1hTokens: number;
    /** Milliseconds since the session's previous request; null for its first. */
    gapMs: number | null;
}
declare const bucketSchema: z.ZodObject<{
    fiveMinuteLoses: z.ZodBoolean;
    sessions: z.ZodNumber;
    requests: z.ZodNumber;
    write1hTokens: z.ZodNumber;
    repriceSavingUsd: z.ZodNumber;
    rebuilds: z.ZodNumber;
    rebuildTokens: z.ZodNumber;
    rebuildCostUsd: z.ZodNumber;
    netSavingUsd: z.ZodNumber;
    netPerSessionUsd: z.ZodNumber;
    key: z.ZodString;
}, z.core.$strip>;
declare const cacheTtlWhatIfSchema: z.ZodObject<{
    window: z.ZodOptional<z.ZodObject<{
        since: z.ZodNullable<z.ZodString>;
        until: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    priceTableVersion: z.ZodNumber;
    rebuildGapBands: z.ZodArray<z.ZodString>;
    totals: z.ZodObject<{
        sessions: z.ZodNumber;
        requests: z.ZodNumber;
        write1hTokens: z.ZodNumber;
        repriceSavingUsd: z.ZodNumber;
        rebuilds: z.ZodNumber;
        rebuildTokens: z.ZodNumber;
        rebuildCostUsd: z.ZodNumber;
        netSavingUsd: z.ZodNumber;
        netPerSessionUsd: z.ZodNumber;
    }, z.core.$strip>;
    unpricedRequests: z.ZodNumber;
    byRole: z.ZodArray<z.ZodObject<{
        fiveMinuteLoses: z.ZodBoolean;
        sessions: z.ZodNumber;
        requests: z.ZodNumber;
        write1hTokens: z.ZodNumber;
        repriceSavingUsd: z.ZodNumber;
        rebuilds: z.ZodNumber;
        rebuildTokens: z.ZodNumber;
        rebuildCostUsd: z.ZodNumber;
        netSavingUsd: z.ZodNumber;
        netPerSessionUsd: z.ZodNumber;
        key: z.ZodString;
    }, z.core.$strip>>;
    byProfile: z.ZodArray<z.ZodObject<{
        fiveMinuteLoses: z.ZodBoolean;
        sessions: z.ZodNumber;
        requests: z.ZodNumber;
        write1hTokens: z.ZodNumber;
        repriceSavingUsd: z.ZodNumber;
        rebuilds: z.ZodNumber;
        rebuildTokens: z.ZodNumber;
        rebuildCostUsd: z.ZodNumber;
        netSavingUsd: z.ZodNumber;
        netPerSessionUsd: z.ZodNumber;
        key: z.ZodString;
    }, z.core.$strip>>;
    lossRoles: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
type CacheTtlWhatIf = z.infer<typeof cacheTtlWhatIfSchema>;
type CacheTtlBucket = z.infer<typeof bucketSchema>;
/** Q3: what each role and profile would have paid with `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` instead of 1h. */
declare function cacheTtlWhatIf(rows: readonly TtlRequestRow[], prices?: readonly PriceRow[]): CacheTtlWhatIf;
/** Reads the graph and never writes it; roles are the cost report's. */
declare function cacheTtlReport(db: Db, options?: CostReportOptions, prices?: readonly PriceRow[]): CacheTtlWhatIf;
declare function readTtlRows(db: Db, window: ReportWindow): TtlRequestRow[];
/** One table per dimension; a role or profile 5m would cost money is marked `loss`. */
declare function renderCacheTtlText(whatIf: CacheTtlWhatIf): string;

/** One reviewer verdict message, as agent-chat's events table records it. */
interface VerdictRecord {
    eventId: number;
    at: string;
    /** The seat the verdict was sent to. */
    seat: string;
    reviewer: string;
    verdict: string;
    repo: string;
    pr: number;
    head: string;
}
/** A PR as GitHub REST reports it at the time of the run. */
interface PullState {
    repo: string;
    pr: number;
    state: "open" | "closed";
    mergedAt: string | null;
    headSha: string;
}
type ParsedVerdict = Pick<VerdictRecord, "verdict" | "repo" | "pr" | "head">;
/** Reads a reviewer message with session-read's gate parser; null when the merge gate would refuse it (short head, URL-form PR, a second block). */
declare function parseVerdict(body: string): ParsedVerdict | null;
type MergeStatus = "merged" | "open" | "stale-head" | "closed" | "unknown";
/** A PR holding at least one MERGE verdict, resolved against its GitHub state at `asOf`. */
interface MergeOutcome {
    repo: string;
    pr: number;
    status: MergeStatus;
    /** The first MERGE verdict at the PR's final head; null when no verdict names that head. */
    verdict: VerdictRecord | null;
    /** Verdict to merge for merged PRs; verdict to `asOf` (a censored age) for open ones. */
    minutes: number | null;
}
declare function mergeOutcomes(verdicts: readonly VerdictRecord[], pulls: readonly PullState[], asOf: string): MergeOutcome[];
declare function prKey(row: {
    repo: string;
    pr: number;
}): string;
declare const latencyStatsSchema: z.ZodObject<{
    merged: z.ZodNumber;
    medianMin: z.ZodNullable<z.ZodNumber>;
    meanMin: z.ZodNullable<z.ZodNumber>;
    p90Min: z.ZodNullable<z.ZodNumber>;
    maxMin: z.ZodNullable<z.ZodNumber>;
    censored: z.ZodNumber;
    oldestCensoredMin: z.ZodNullable<z.ZodNumber>;
    censoredPrMinutes: z.ZodNumber;
    medianWithCensoredMin: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
type LatencyStats = z.infer<typeof latencyStatsSchema>;
declare function latencyStats(outcomes: readonly MergeOutcome[]): LatencyStats;

/** One action the auto-mode classifier refused, read from a seat's transcript. */
interface DenialRecord {
    seat: string;
    at: string;
    /** The classifier's bracketed reason, such as "Merge Without Review". */
    reason: string;
    /** What the refused call was doing, from its tool input; the reason label alone is loose. */
    action: string;
    tool: string;
    /** The refused call's id; a forked or resumed transcript repeats it, so it is counted once. */
    toolUseId?: string;
}
/** Classifies a refused call by what it did; MCP tools keep their own short name. */
declare function classifyDeniedAction(tool: string, input: unknown): string;
/** Scans transcript JSONL for classifier refusals and joins each to the tool call it refused. */
declare function parseDenials(lines: Iterable<string>, seat: string): DenialRecord[];
/** One denial per refused call; a record without a tool_use_id cannot be matched and is kept. */
declare function dedupeDenials(denials: readonly DenialRecord[]): DenialRecord[];

/** A seat journal line that states its implementer slot count, and why it did not fill a free slot. */
interface SlotTick {
    seat: string;
    at: string;
    used: number;
    cap: number;
    reason: string;
    /** The journal line number, so a row can be checked against its source. */
    line: number;
}
interface SeatJournal {
    ticks: SlotTick[];
    /** The journal's last timestamped line; the final tick holds until then. */
    lastAt: string | null;
}
declare const UNSTATED_REASON = "unstated";
/** A tick's count holds at most this long, so a dark seat is not read as an hour of idle slots. */
declare const TICK_HOLD_MAX_MIN = 60;
/**
 * Reads `HH:MM[:SS] ...` journal lines for the date the journal covers.
 * `utcOffsetMin` is the journal clock's offset east of UTC, such as -360 for UTC-6.
 */
declare function parseSeatJournal(text: string, seat: string, date: string, utcOffsetMin: number): SeatJournal;
interface IdleSlotRow {
    seat: string;
    reason: string;
    slotMinutes: number;
    ticks: number;
    /** Journal line numbers of the ticks counted here. */
    lines: number[];
}
/** Free implementer slots times the minutes each tick's count held, clipped to the window. */
declare function idleSlotMinutes(journals: readonly SeatJournal[], window: {
    since?: string;
    until?: string;
}): IdleSlotRow[];

/** Where each section's numbers come from: the command that re-reads them and the field it reads. */
declare const BLOCKED_FLOW_SOURCES: {
    readonly verdicts: {
        readonly command: string;
        readonly field: "events.ts, events.target, events.actor (reviewer), events.body lines Verdict:, PR:, Head:";
    };
    readonly pulls: {
        readonly command: "gh api repos/<owner>/<repo>/pulls/<n>";
        readonly field: ".state, .merged_at, .head.sha";
    };
    readonly denials: {
        readonly command: "grep 'auto mode classifier. Reason: \\[' <seat transcript>.jsonl";
        readonly field: "tool_result.content Reason: [<class>], joined to tool_use.input by tool_use_id";
    };
    readonly journals: {
        readonly command: "grep -nE 'impl [0-9]+/[0-9]+' <seat journal>.md";
        readonly field: "impl <used>/<cap>, No dispatch: <reason>";
    };
};
type BlockedFlowSource = keyof typeof BLOCKED_FLOW_SOURCES;
interface BlockedFlowInput {
    verdicts: readonly VerdictRecord[];
    /** Verdict messages the caller could not read with `parseVerdict`, already scoped to the window and seats. */
    unparsedVerdicts?: number;
    pulls: readonly PullState[];
    denials: readonly DenialRecord[];
    journals: readonly SeatJournal[];
    /** Waits are measured to here; a PR merged later counts as open. */
    asOf: string;
    window?: {
        since?: string;
        until?: string;
    };
    /** Splits verdict-to-merge by verdict time, such as the moment a seat was granted merge authority. */
    splitAt?: string;
    /** Keeps only verdicts sent to, and denials and journals of, these seats. */
    seats?: readonly string[];
}
declare const latencyRowSchema: z.ZodObject<{
    repo: z.ZodString;
    prs: z.ZodNumber;
    staleHead: z.ZodNumber;
    closed: z.ZodNumber;
    unknown: z.ZodNumber;
    all: z.ZodObject<{
        merged: z.ZodNumber;
        medianMin: z.ZodNullable<z.ZodNumber>;
        meanMin: z.ZodNullable<z.ZodNumber>;
        p90Min: z.ZodNullable<z.ZodNumber>;
        maxMin: z.ZodNullable<z.ZodNumber>;
        censored: z.ZodNumber;
        oldestCensoredMin: z.ZodNullable<z.ZodNumber>;
        censoredPrMinutes: z.ZodNumber;
        medianWithCensoredMin: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    before: z.ZodOptional<z.ZodObject<{
        merged: z.ZodNumber;
        medianMin: z.ZodNullable<z.ZodNumber>;
        meanMin: z.ZodNullable<z.ZodNumber>;
        p90Min: z.ZodNullable<z.ZodNumber>;
        maxMin: z.ZodNullable<z.ZodNumber>;
        censored: z.ZodNumber;
        oldestCensoredMin: z.ZodNullable<z.ZodNumber>;
        censoredPrMinutes: z.ZodNumber;
        medianWithCensoredMin: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    after: z.ZodOptional<z.ZodObject<{
        merged: z.ZodNumber;
        medianMin: z.ZodNullable<z.ZodNumber>;
        meanMin: z.ZodNullable<z.ZodNumber>;
        p90Min: z.ZodNullable<z.ZodNumber>;
        maxMin: z.ZodNullable<z.ZodNumber>;
        censored: z.ZodNumber;
        oldestCensoredMin: z.ZodNullable<z.ZodNumber>;
        censoredPrMinutes: z.ZodNumber;
        medianWithCensoredMin: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const blockedFlowSchema: z.ZodObject<{
    asOf: z.ZodString;
    window: z.ZodObject<{
        since: z.ZodOptional<z.ZodString>;
        until: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    splitAt: z.ZodOptional<z.ZodString>;
    sources: z.ZodRecord<z.ZodEnum<{
        verdicts: "verdicts";
        pulls: "pulls";
        denials: "denials";
        journals: "journals";
    }>, z.ZodObject<{
        command: z.ZodString;
        field: z.ZodString;
    }, z.core.$strip>>;
    verdictToMerge: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            verdicts: "verdicts";
            pulls: "pulls";
            denials: "denials";
            journals: "journals";
        }>>;
        rows: z.ZodArray<z.ZodObject<{
            repo: z.ZodString;
            prs: z.ZodNumber;
            staleHead: z.ZodNumber;
            closed: z.ZodNumber;
            unknown: z.ZodNumber;
            all: z.ZodObject<{
                merged: z.ZodNumber;
                medianMin: z.ZodNullable<z.ZodNumber>;
                meanMin: z.ZodNullable<z.ZodNumber>;
                p90Min: z.ZodNullable<z.ZodNumber>;
                maxMin: z.ZodNullable<z.ZodNumber>;
                censored: z.ZodNumber;
                oldestCensoredMin: z.ZodNullable<z.ZodNumber>;
                censoredPrMinutes: z.ZodNumber;
                medianWithCensoredMin: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>;
            before: z.ZodOptional<z.ZodObject<{
                merged: z.ZodNumber;
                medianMin: z.ZodNullable<z.ZodNumber>;
                meanMin: z.ZodNullable<z.ZodNumber>;
                p90Min: z.ZodNullable<z.ZodNumber>;
                maxMin: z.ZodNullable<z.ZodNumber>;
                censored: z.ZodNumber;
                oldestCensoredMin: z.ZodNullable<z.ZodNumber>;
                censoredPrMinutes: z.ZodNumber;
                medianWithCensoredMin: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>>;
            after: z.ZodOptional<z.ZodObject<{
                merged: z.ZodNumber;
                medianMin: z.ZodNullable<z.ZodNumber>;
                meanMin: z.ZodNullable<z.ZodNumber>;
                p90Min: z.ZodNullable<z.ZodNumber>;
                maxMin: z.ZodNullable<z.ZodNumber>;
                censored: z.ZodNumber;
                oldestCensoredMin: z.ZodNullable<z.ZodNumber>;
                censoredPrMinutes: z.ZodNumber;
                medianWithCensoredMin: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    refusedVerdicts: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            verdicts: "verdicts";
            pulls: "pulls";
            denials: "denials";
            journals: "journals";
        }>>;
        count: z.ZodNumber;
    }, z.core.$strip>;
    openHoldingMerge: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            verdicts: "verdicts";
            pulls: "pulls";
            denials: "denials";
            journals: "journals";
        }>>;
        prMinutes: z.ZodNumber;
        rows: z.ZodArray<z.ZodObject<{
            repo: z.ZodString;
            pr: z.ZodNumber;
            head: z.ZodString;
            seat: z.ZodString;
            verdictAt: z.ZodString;
            ageMin: z.ZodNumber;
            eventId: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    denials: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            verdicts: "verdicts";
            pulls: "pulls";
            denials: "denials";
            journals: "journals";
        }>>;
        total: z.ZodNumber;
        rows: z.ZodArray<z.ZodObject<{
            reason: z.ZodString;
            action: z.ZodString;
            seat: z.ZodString;
            count: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    idleSlots: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            verdicts: "verdicts";
            pulls: "pulls";
            denials: "denials";
            journals: "journals";
        }>>;
        holdMaxMin: z.ZodNumber;
        total: z.ZodNumber;
        rows: z.ZodArray<z.ZodObject<{
            seat: z.ZodString;
            reason: z.ZodString;
            slotMinutes: z.ZodNumber;
            ticks: z.ZodNumber;
            lines: z.ZodArray<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
type BlockedFlowReport = z.infer<typeof blockedFlowSchema>;
type LatencyRow = z.infer<typeof latencyRowSchema>;
declare const ALL_REPOS = "all";
/** Per repo: verdict-to-merge waits, PRs still holding MERGE, classifier denials and idle implementer slots. */
declare function blockedFlowReport(input: BlockedFlowInput): BlockedFlowReport;
/** Each table's title names the JSON field its numbers come from; the sources close the report. */
declare function renderBlockedFlowText(report: BlockedFlowReport): string;

/** One agent-chat broker.log entry and the 1-based line it came from, so each finding can cite it. */
interface BrokerEntry {
    line: number;
    ts: string;
    event: string;
    fields: Record<string, unknown>;
}
/** Broker log lines to entries; a line that is not a JSON object with `ts` and `event` is skipped but still counted. */
declare function parseBrokerLog(lines: Iterable<string>): BrokerEntry[];

/**
 * How a route missed a recipient: `failed` is a `delivered:false` the broker dropped, `partial` reached
 * others but not this name, and `queued` is a `delivered:false` the broker kept for later delivery.
 */
type RouteMissKind = "failed" | "partial" | "queued";
/** One recipient a routed message did not reach when it was sent. */
interface RouteMiss {
    line: number;
    at: string;
    recipient: string;
    from: string;
    kind: string;
    miss: RouteMissKind;
}
interface RouteFailureRow {
    recipient: string;
    failed: number;
    partial: number;
    queued: number;
    first: string;
    last: string;
    lines: number[];
}
/** Each recipient named in `to` that a route did not reach. */
declare function routeMisses(entries: readonly BrokerEntry[]): RouteMiss[];
/** Misses grouped by recipient, most first. */
declare function routeFailureRows(misses: readonly RouteMiss[]): RouteFailureRow[];
declare function countMisses(misses: readonly RouteMiss[]): Record<RouteMissKind, number>;

/** A seat off the broker for longer than this is dark; a teleport hand-off takes seconds. */
declare const DARK_MIN = 5;
/** A name deregistered from the broker until it registered again, or until asOf if it never did, without exiting in between. */
interface DarkGap {
    seat: string;
    from: string;
    to: string | null;
    minutes: number;
    /** A teleport of this name started after its last registration and before the gap closed. */
    teleport: boolean;
    /** Routes to the seat during the gap logged `delivered:false` and dropped. */
    failedRoutes: number;
    /** Routes during the gap that reached other recipients but not the seat. */
    partialRoutes: number;
    /** Routes the broker held or queued in the seat's inbox for delivery when it returned. */
    queuedRoutes: number;
    /** The deregistered and registered lines, then any teleport lines. */
    lines: number[];
    routeLines: number[];
}
/** Gaps longer than DARK_MIN, skipping a clean exit and later resume; one still open at asOf counts only if a route missed the seat in it. */
declare function darkGaps(entries: readonly BrokerEntry[], misses: readonly RouteMiss[], asOf: string): DarkGap[];

/** An `agent_spawned` row of agent-chat's events table: the agent id and the profile it ran under. */
interface SpawnRecord {
    eventId: number;
    agentId: string;
    name: string;
    profile: string | null;
}
/** An agent the broker saw exit without reporting to its spawner. */
interface UnreportedExit {
    at: string;
    line: number;
    agentId: string;
    name: string;
    spawner: string;
    lastAction: string;
    /** The `agent_spawned` row the profile came from, or null when none matched the agent id. */
    spawnEventId: number | null;
}
interface UnreportedExitRow {
    profile: string;
    count: number;
    exits: UnreportedExit[];
}
declare const UNKNOWN_PROFILE = "unknown";
/** Broker `unreported-exit` lines grouped by the profile the agent was spawned with, most first. */
declare function unreportedExitRows(entries: readonly BrokerEntry[], spawns: readonly SpawnRecord[]): UnreportedExitRow[];

/** A prompt this old with nothing after it from the agent is a hang, not a pause for the owner. */
declare const PROMPT_STALE_MIN = 10;
/** The newest events-table row an actor wrote before asOf. */
interface LastEventRecord {
    eventId: number;
    at: string;
    actor: string;
    kind: string;
    /** `meta.tool_name` of an approval request. */
    tool: string | null;
    /** A `resolution` row whose `ref` is this request's msg_id, written before asOf. */
    resolutionEventId: number | null;
    /** An `agent_exited` or `agent_retired` row for this actor after the request and before asOf. */
    endEventId: number | null;
}
interface StalePromptRow {
    agent: string;
    at: string;
    ageMin: number;
    tool: string | null;
    eventId: number;
    resolutionEventId: number | null;
}
/** Live agents whose last event is an approval request older than PROMPT_STALE_MIN, oldest first; resolved ones included. */
declare function stalePromptRows(lastEvents: readonly LastEventRecord[], broker: readonly BrokerEntry[], asOf: string): StalePromptRow[];

/** Where each section's findings come from: the command that re-reads them and the field it reads. */
declare const LIVENESS_SOURCES: {
    readonly registrations: {
        readonly command: "grep -nE '\"event\":\"(broker_started|registered|deregistered|agent_exited|teleport_started|teleport_completed|teleport_failed|teleport_aborted)\"' <broker.log>";
        readonly field: "ts, event, name; cited as broker.log line numbers; a gap with a clean agent_exited (code 0, not inferred) and no teleport is a resume; a prompt before the last broker_started from an agent never registered after it is skipped";
    };
    readonly routes: {
        readonly command: "grep -n '\"event\":\"route\"' <broker.log>";
        readonly field: "to, delivered, recipients";
    };
    readonly exits: {
        readonly command: "grep -n '\"event\":\"unreported-exit\"' <broker.log>";
        readonly field: "agentId, name, spawner, lastAction";
    };
    readonly spawns: {
        readonly command: string;
        readonly field: "events.msg_id (agent id), events.target (name), events.meta.profile";
    };
    readonly prompts: {
        readonly command: string;
        readonly field: "events.ts, events.actor, events.meta.tool_name; a resolution row's events.ref; skipped after the actor's agent_exited or agent_retired (endEventId)";
    };
};
type LivenessSource = keyof typeof LIVENESS_SOURCES;
interface LivenessInput {
    broker: readonly BrokerEntry[];
    spawns: readonly SpawnRecord[];
    lastEvents: readonly LastEventRecord[];
    /** Gaps still open and prompt ages are measured to here; later entries are ignored. */
    asOf: string;
    /** A finding is kept when it starts inside the window; a prompt from a live agent still unanswered at asOf is kept however old. */
    window?: {
        since?: string;
        until?: string;
    };
    /** Keeps only findings about these names: the dark seat, route recipient, exiting agent or its spawner, prompting agent. */
    seats?: readonly string[];
}
declare const livenessSchema: z.ZodObject<{
    asOf: z.ZodString;
    window: z.ZodObject<{
        since: z.ZodOptional<z.ZodString>;
        until: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    thresholds: z.ZodObject<{
        darkMin: z.ZodNumber;
        promptStaleMin: z.ZodNumber;
    }, z.core.$strip>;
    sources: z.ZodRecord<z.ZodEnum<{
        exits: "exits";
        registrations: "registrations";
        routes: "routes";
        spawns: "spawns";
        prompts: "prompts";
    }>, z.ZodObject<{
        command: z.ZodString;
        field: z.ZodString;
    }, z.core.$strip>>;
    darkSeats: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            exits: "exits";
            registrations: "registrations";
            routes: "routes";
            spawns: "spawns";
            prompts: "prompts";
        }>>;
        withTeleport: z.ZodNumber;
        withoutTeleport: z.ZodNumber;
        rows: z.ZodArray<z.ZodObject<{
            seat: z.ZodString;
            from: z.ZodString;
            to: z.ZodNullable<z.ZodString>;
            minutes: z.ZodNumber;
            teleport: z.ZodBoolean;
            failedRoutes: z.ZodNumber;
            partialRoutes: z.ZodNumber;
            queuedRoutes: z.ZodNumber;
            lines: z.ZodArray<z.ZodNumber>;
            routeLines: z.ZodArray<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    routeFailures: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            exits: "exits";
            registrations: "registrations";
            routes: "routes";
            spawns: "spawns";
            prompts: "prompts";
        }>>;
        failed: z.ZodNumber;
        partial: z.ZodNumber;
        queued: z.ZodNumber;
        rows: z.ZodArray<z.ZodObject<{
            recipient: z.ZodString;
            failed: z.ZodNumber;
            partial: z.ZodNumber;
            queued: z.ZodNumber;
            first: z.ZodString;
            last: z.ZodString;
            lines: z.ZodArray<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    unreportedExits: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            exits: "exits";
            registrations: "registrations";
            routes: "routes";
            spawns: "spawns";
            prompts: "prompts";
        }>>;
        total: z.ZodNumber;
        rows: z.ZodArray<z.ZodObject<{
            profile: z.ZodString;
            count: z.ZodNumber;
            exits: z.ZodArray<z.ZodObject<{
                at: z.ZodString;
                line: z.ZodNumber;
                agentId: z.ZodString;
                name: z.ZodString;
                spawner: z.ZodString;
                lastAction: z.ZodString;
                spawnEventId: z.ZodNullable<z.ZodNumber>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    stalePrompts: z.ZodObject<{
        cites: z.ZodArray<z.ZodEnum<{
            exits: "exits";
            registrations: "registrations";
            routes: "routes";
            spawns: "spawns";
            prompts: "prompts";
        }>>;
        rows: z.ZodArray<z.ZodObject<{
            agent: z.ZodString;
            at: z.ZodString;
            ageMin: z.ZodNumber;
            tool: z.ZodNullable<z.ZodString>;
            eventId: z.ZodNumber;
            resolutionEventId: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
        resolvedRows: z.ZodArray<z.ZodObject<{
            agent: z.ZodString;
            at: z.ZodString;
            ageMin: z.ZodNumber;
            tool: z.ZodNullable<z.ZodString>;
            eventId: z.ZodNumber;
            resolutionEventId: z.ZodNullable<z.ZodNumber>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strip>;
type LivenessReport = z.infer<typeof livenessSchema>;
/** Seats dark past DARK_MIN, routes that missed their recipient, unreported exits and agents stuck on a prompt. */
declare function livenessReport(input: LivenessInput): LivenessReport;
/** Each table's title names the JSON field its rows come from; the sources and the shared caveat close the report. */
declare function renderLivenessText(report: LivenessReport): string;

/** agent-chat's events table as these readers expect it, from agent-chat's src/broker/event-log.ts; a fixture creates it with this. */
declare const EVENTS_TABLE_DDL = "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,\n  target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)";
/** A runnable sqlite3 command for `sql`, binding each `@name` parameter to an epoch-millisecond placeholder through `.parameter set`. */
declare function eventsDbCommand(sql: string): string;
declare const VERDICTS_SQL = "SELECT id, ts, actor, target, body FROM events WHERE kind = 'message' AND body LIKE 'Verdict:%' AND ts >= @since AND ts < @until ORDER BY id";
/** Verdict messages, and how many `Verdict:` messages parseVerdict refused; window bounds are ISO and inclusive-exclusive, and `seats` limits the refused count to verdicts sent to those seats. */
declare function readVerdicts(db: Db, window: {
    since?: string;
    until?: string;
}, seats?: readonly string[]): {
    verdicts: VerdictRecord[];
    unparsed: number;
};
declare const SPAWNS_SQL: string;
/** Each `agent_spawned` row's agent id, name and profile. */
declare function readSpawns(db: Db): SpawnRecord[];
declare const LAST_PROMPTS_SQL: string;
/** Each actor's newest event before asOf other than a resolution, kept only where it is an approval request, with any resolution of it and any later exit or retirement. */
declare function readLastPrompts(db: Db, asOf: string): LastEventRecord[];
/** A seat's handoff as agent-chat stores it: `actor` is the name the successor keeps, `ref` the outgoing agent id, `meta.successor` the incoming one. */
interface HandoffRecord {
    eventId: number;
    at: string;
    seat: string;
    predecessorId: string;
    successorId: string | null;
    /** The predecessor stood down afterwards; an uncommitted handoff is a teleport that was aborted. */
    committed: boolean;
}
declare const HANDOFFS_SQL: string;
/**
 * `agent_handoff` rows at or after `since` (ISO), oldest first. To resolve seat generations, omit
 * `since`: the generation live at a window's start began with a handoff written before it.
 */
declare function readHandoffs(db: Db, since?: string): HandoffRecord[];

/** The broker logs this once a teleport's successor holds the name; a started, failed or aborted teleport ends nothing. */
declare const TELEPORT_COMPLETED_EVENT = "teleport_completed";
type GenerationEnd = "handoff" | "teleport" | "exit" | "open";
/** One agent process that held the seat's name, from its start to the record that ended it. */
interface SeatGeneration {
    /** 1-based position among the generations returned. */
    generation: number;
    agentId: string;
    agentName: string;
    /** Graph sessions the agent ran as, one per resume; empty when the graph has none, so the generation still shows. */
    sessionIds: string[];
    /** Null when no spawn line or predecessor handoff records it, e.g. before the broker log rotated. */
    start: string | null;
    end: string | null;
    endedBy: GenerationEnd;
}
interface SeatGenerationsInput {
    handoffs: readonly HandoffRecord[];
    broker: readonly BrokerEntry[];
    /** Agent id to the graph sessions it ran as, as `readAgentSessions` returns it. */
    agentSessions: ReadonlyMap<string, readonly string[]>;
    seat: string;
    /** Drop generations that ended before this ISO time; the one running at it is kept. */
    since?: string;
}
declare const seatGenerationsSchema: z.ZodArray<z.ZodObject<{
    generation: z.ZodNumber;
    agentId: z.ZodString;
    agentName: z.ZodString;
    sessionIds: z.ZodArray<z.ZodString>;
    start: z.ZodNullable<z.ZodString>;
    end: z.ZodNullable<z.ZodString>;
    endedBy: z.ZodEnum<{
        handoff: "handoff";
        open: "open";
        teleport: "teleport";
        exit: "exit";
    }>;
}, z.core.$strip>>;
/** The seat's generations in start order: committed handoffs, completed teleports and exits end one; spawns and handoffs start one. */
declare function seatGenerations(input: SeatGenerationsInput): SeatGeneration[];

/** Bump when a field is removed or changes meaning. Adding a field keeps the version. */
declare const SESSION_TIMELINE_VERSION = 1;
/** Idle time between two events that counts as a gap. */
declare const TIMELINE_GAP_MIN_MS: number;
/** Default cap on each message text. The byte offset still points at the full record. */
declare const TIMELINE_TEXT_CAP = 4000;
/** `prompt` is typed or sent text, `injected` is a harness block, `compaction` is a continuation summary, `none` is activity before any user message. */
type TimelineTurnOrigin = "prompt" | "injected" | "compaction" | "none";
/** `unknown` is a result whose source did not report an error state; `pending` has no result yet. */
type TimelineToolOutcome = "success" | "error" | "unknown" | "pending";
interface TimelineMessage {
    role: "user" | "assistant";
    /** Source order across the whole session; sort a turn's messages and tool calls by it to interleave them. */
    seq: number;
    atMs: number | null;
    text: string;
    /** True when `text` was cut at the cap. */
    truncated: boolean;
    /** Offset of the transcript line, for reading the full record. */
    byteOffset: number;
}
interface TimelineToolCall {
    /** The harness's own call id, unique within the session. */
    id: string;
    seq: number;
    turnIndex: number;
    name: string;
    family: ToolFamily;
    atMs: number | null;
    /** When the result arrived; null while pending. */
    endMs: number | null;
    /** Observed call-to-result span, not harness execution time. */
    durationMs: number | null;
    outcome: TimelineToolOutcome;
    errorMessage: string | null;
    /** One line naming what the call acted on: a path, a command, a pattern or a description. */
    inputSummary: string;
    filePath: string | null;
    sidechain: boolean;
    byteOffset: number;
}
/** Prompt-side counts are disjoint: `input` excludes cache reads and cache writes. */
interface TimelineTokens {
    input: number;
    cacheRead: number;
    /** All cache writes, `cacheWrite5m + cacheWrite1h`. */
    cacheWrite: number;
    /** Writes at the 5m rate, including a total the source reported without a split. */
    cacheWrite5m: number;
    /** Writes at the 1h rate. */
    cacheWrite1h: number;
    output: number;
}
interface TimelineTurn {
    index: number;
    origin: TimelineTurnOrigin;
    /** The session-read injected-marker name when `origin` is `injected` or `compaction`. */
    injectedMarker: string | null;
    startMs: number | null;
    endMs: number | null;
    /** Idle time before this turn when it is `TIMELINE_GAP_MIN_MS` or more, else null. */
    gapBeforeMs: number | null;
    /** The message that opened the turn; null when `origin` is `none`. */
    user: TimelineMessage | null;
    assistant: TimelineMessage[];
    toolCalls: TimelineToolCall[];
    errorCount: number;
    tokens: TimelineTokens;
    costUsd: number;
}
/** One UTC clock minute that held activity. Minutes with none are omitted. */
interface TimelineMinuteBucket {
    /** Start of the minute. */
    minuteMs: number;
    /** Messages, tool calls and tool results. */
    events: number;
    messages: number;
    toolCalls: number;
    errors: number;
    outputTokens: number;
    costUsd: number;
    /** Set on the first bucket after a gap. */
    gapBeforeMs: number | null;
}
/** An idle stretch. Time spent waiting on a tool call that later returned is not idle, so it is never a gap. */
interface TimelineGap {
    startMs: number;
    endMs: number;
    durationMs: number;
}
/** One API request. Points are in source order and cumulative fields run over that order. */
interface TimelineTokenPoint {
    atMs: number;
    turnIndex: number | null;
    model: string | null;
    /** The prompt size of this request: input plus cache read plus cache write. Null when the source omitted a count. */
    contextTokens: number | null;
    outputTokens: number;
    cumulativeOutputTokens: number;
    costUsd: number;
    cumulativeCostUsd: number;
    /** False when no price row covers the model; `costUsd` is then 0. */
    priced: boolean;
    /** True on the first request after a compaction. */
    afterCompaction: boolean;
}
interface CompactionMark {
    atMs: number | null;
    turnIndex: number | null;
    byteOffset: number;
    summary: string | null;
    summaryTruncated: boolean;
}
interface ModelRequests {
    model: string;
    requests: number;
}
interface TokenTimeline {
    /** `delta` has per-request points. A `snapshot` source reports running totals only: `points` is empty and nothing is priced, so every `costUsd` is 0. */
    basis: "delta" | "snapshot" | "unreported";
    points: TimelineTokenPoint[];
    compactions: CompactionMark[];
    /** Most requests first. */
    models: ModelRequests[];
}
interface ToolNameCount {
    name: string;
    family: ToolFamily;
    calls: number;
    errors: number;
    durationMs: number;
}
interface ToolFamilyCount {
    family: ToolFamily;
    calls: number;
    errors: number;
    /** Call start times, ascending, for `countAtOrBefore`. */
    atMs: number[];
}
interface TimelineToolBreakdown {
    /** Most calls first. */
    byName: ToolNameCount[];
    byFamily: ToolFamilyCount[];
    /** Every call start time, ascending. */
    atMs: number[];
}
interface TimelineFileTouch {
    path: string;
    access: "read" | "write";
    /** First touch of this path with this access. */
    atMs: number | null;
    calls: number;
}
interface TimelineFileBreakdown {
    /** One row per path and access, ordered by first touch. */
    touches: TimelineFileTouch[];
    readCount: number;
    writeCount: number;
}
interface TimelineError {
    callId: string;
    toolName: string;
    turnIndex: number;
    /** When the failing result arrived. */
    atMs: number | null;
    message: string;
    sidechain: boolean;
}
interface TimelineErrorBreakdown {
    /** Failed calls over all calls; 0 with no calls. */
    rate: number;
    items: TimelineError[];
    atMs: number[];
}
/** A subagent dispatch, from its tool call to that call's result. */
interface TimelineAgentSpan {
    callId: string;
    label: string;
    startMs: number | null;
    endMs: number | null;
    outcome: TimelineToolOutcome;
}
interface TimelineTotals {
    turns: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    errors: number;
    compactions: number;
    /** API requests with usage. Null on a `snapshot` basis, which cannot count them. */
    requests: number | null;
    unpricedRequests: number;
    tokens: TimelineTokens;
    /** 0 on a `snapshot` basis, which has no per-request usage to price. */
    costUsd: number;
}
/**
 * Everything a session view reads, as plain JSON. Every `*Ms` field is epoch milliseconds,
 * so the model holds no time zone and a renderer picks one.
 */
interface SessionTimeline {
    version: typeof SESSION_TIMELINE_VERSION;
    sessionId: string | null;
    harness: string | null;
    startMs: number | null;
    endMs: number | null;
    durationMs: number;
    totals: TimelineTotals;
    turns: TimelineTurn[];
    buckets: TimelineMinuteBucket[];
    gaps: TimelineGap[];
    tokens: TokenTimeline;
    tools: TimelineToolBreakdown;
    files: TimelineFileBreakdown;
    errors: TimelineErrorBreakdown;
    agents: TimelineAgentSpan[];
}

interface SessionTimelineOptions {
    /** Idle time that counts as a gap. Defaults to `TIMELINE_GAP_MIN_MS`. */
    gapMinMs?: number;
    /** Cap on each message and compaction summary. Defaults to `TIMELINE_TEXT_CAP`. */
    maxTextChars?: number;
    /** Price rows for the cost series. Defaults to `PRICE_TABLE`. */
    prices?: readonly PriceRow[];
}
/** Storage-free fold for a streamed read: `add` each observation, then `result`, which returns a fresh copy each time. */
declare class SessionTimelineAccumulator {
    private readonly turns;
    private readonly tokens;
    private readonly gapMinMs;
    private conversation;
    private startMs;
    private endMs;
    constructor(options?: SessionTimelineOptions);
    add(observation: NormalizedSessionObservation): void;
    result(): SessionTimeline;
    private claim;
    /** A record with no usable timestamp takes the latest one seen, so it still lands in order. */
    private clock;
}
/** The read model behind every session view: turns, minute buckets, the token and cost series, and tool, file and error breakdowns. */
declare function buildSessionTimeline(observations: Iterable<NormalizedSessionObservation>, options?: SessionTimelineOptions): SessionTimeline;

/** How many of the ascending `sortedMs` are at or before `targetMs`, by binary search. */
declare function countAtOrBefore(sortedMs: readonly number[], targetMs: number): number;

declare const reviewFillSchema: z.ZodObject<{
    window: z.ZodObject<{
        since: z.ZodNullable<z.ZodString>;
        until: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    unfilled: z.ZodNumber;
    unresolved: z.ZodNumber;
    rows: z.ZodArray<z.ZodObject<{
        band: z.ZodString;
        model: z.ZodString;
        verdicts: z.ZodNumber;
        changesRequested: z.ZodNumber;
        changesRate: z.ZodNullable<z.ZodNumber>;
        verdictErrors: z.ZodNumber;
        errorRate: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type ReviewFillReport = z.infer<typeof reviewFillSchema>;
/** Review verdicts in the window by the reviewer's context fill when it issued them, and how often an approve was contradicted. */
declare function reviewFillReport(db: Db, window: ReportWindow): ReviewFillReport;

/** One dispatch of an agent to a task by a seat, in no product's log format; adapters build these. */
declare const assignmentSchema: z.ZodObject<{
    seat: z.ZodString;
    agent: z.ZodString;
    task: z.ZodNullable<z.ZodString>;
    kind: z.ZodNullable<z.ZodString>;
    initiative: z.ZodNullable<z.ZodString>;
    outcome: z.ZodNullable<z.ZodString>;
    value: z.ZodNullable<z.ZodString>;
    pr: z.ZodNullable<z.ZodString>;
    ts: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
type Assignment = z.infer<typeof assignmentSchema>;
interface CostPerOutcomeOptions extends ReportWindow {
    /** Outcomes that count as merged; defaults to `["merged"]`. */
    mergedOutcomes?: readonly string[];
    /** Outcomes that count as done; defaults to `["done"]`. */
    doneOutcomes?: readonly string[];
}
declare const outcomeBucketSchema: z.ZodObject<{
    key: z.ZodString;
    assignments: z.ZodNumber;
    merged: z.ZodNumber;
    done: z.ZodNumber;
    costUsd: z.ZodNumber;
    usdPerMerged: z.ZodNullable<z.ZodNumber>;
    usdPerDone: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
declare const costPerOutcomeSchema: z.ZodObject<{
    window: z.ZodObject<{
        since: z.ZodNullable<z.ZodString>;
        until: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    totals: z.ZodObject<{
        key: z.ZodString;
        assignments: z.ZodNumber;
        merged: z.ZodNumber;
        done: z.ZodNumber;
        costUsd: z.ZodNumber;
        usdPerMerged: z.ZodNullable<z.ZodNumber>;
        usdPerDone: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    bySeat: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        assignments: z.ZodNumber;
        merged: z.ZodNumber;
        done: z.ZodNumber;
        costUsd: z.ZodNumber;
        usdPerMerged: z.ZodNullable<z.ZodNumber>;
        usdPerDone: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    byKind: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        assignments: z.ZodNumber;
        merged: z.ZodNumber;
        done: z.ZodNumber;
        costUsd: z.ZodNumber;
        usdPerMerged: z.ZodNullable<z.ZodNumber>;
        usdPerDone: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    byInitiative: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        assignments: z.ZodNumber;
        merged: z.ZodNumber;
        done: z.ZodNumber;
        costUsd: z.ZodNumber;
        usdPerMerged: z.ZodNullable<z.ZodNumber>;
        usdPerDone: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    byValue: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        assignments: z.ZodNumber;
        merged: z.ZodNumber;
        done: z.ZodNumber;
        costUsd: z.ZodNumber;
        usdPerMerged: z.ZodNullable<z.ZodNumber>;
        usdPerDone: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    seatCostUsd: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        costUsd: z.ZodNumber;
    }, z.core.$strip>>;
    joinSource: z.ZodObject<{
        agentName: z.ZodNumber;
        taskId: z.ZodNumber;
        seat: z.ZodNumber;
        none: z.ZodNumber;
    }, z.core.$strip>;
    unmatchedAgents: z.ZodArray<z.ZodString>;
}, z.core.$strip>;
type CostPerOutcomeReport = z.infer<typeof costPerOutcomeSchema>;
type OutcomeBucket = z.infer<typeof outcomeBucketSchema>;
/**
 * What each merged and done outcome cost, per seat, kind, initiative and value tag. An agent's
 * window spend is split evenly over its assignments, so a fix round does not cost it twice.
 */
declare function costPerOutcome(db: Db, assignments: readonly Assignment[], options: CostPerOutcomeOptions): CostPerOutcomeReport;
/** The report as plain-text tables: totals, the four groupings, seat spend, the join line and the caveat. */
declare function renderCostPerOutcomeText(report: CostPerOutcomeReport): string;

declare const DEFAULT_BOOT_REQUESTS = 30;
interface SuccessorReworkOptions {
    /** How many of the successor's first main-thread requests count as its boot. */
    bootRequests?: number;
}
declare const successorReworkSchema: z.ZodObject<{
    window: z.ZodObject<{
        since: z.ZodNullable<z.ZodString>;
        until: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    bootRequests: z.ZodNumber;
    fileReadData: z.ZodBoolean;
    rows: z.ZodArray<z.ZodObject<{
        role: z.ZodString;
        pairs: z.ZodNumber;
        meanBootReads: z.ZodNumber;
        meanRereads: z.ZodNumber;
        rereadShare: z.ZodNullable<z.ZodNumber>;
        rereadCostUsd: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
type SuccessorReworkReport = z.infer<typeof successorReworkSchema>;
/**
 * Per role, how much of a successor's boot reading re-reads files its same-named predecessor already
 * read. A guardrail proxy for handoff quality, not a cost to minimise.
 */
declare function successorReworkReport(db: Db, window: ReportWindow, options?: SuccessorReworkOptions): SuccessorReworkReport;

declare const STAGES: readonly ["queued", "ci", "review", "re-review", "hold", "land"];
type ShepherdStage = (typeof STAGES)[number];
type StageMinutes = Partial<Record<ShepherdStage, number>>;
type MergePath = "shepherd" | "outside";
/** One Shepherd run as `titan-factory shepherd stats --per-run --json` prints it. */
interface ShepherdRunRecord {
    runId: string;
    /** `<initiative>/<id>`, or null when the run was registered without a task. */
    task: string | null;
    /** `owner/name`, lowercase. */
    repo: string;
    pr: number | null;
    kind: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    stageMinutes: StageMinutes;
    /** Distinct heads the run awaited a verdict on, already deduped within the run. */
    reviewRounds: number;
    mergedAt: string | null;
    mergePath: MergePath | null;
}
/**
 * The Shepherd facts on a row. Null means unknown, not zero: no joined run, or a merge before
 * Shepherd's ledger began.
 */
interface ShepherdFacts {
    reviewRounds: number | null;
    stageMinutes: StageMinutes | null;
    /** First implementer request to the earliest merge. */
    serviceWallHours: number | null;
    mergePath: MergePath | null;
}

declare const DEFAULT_ACTIVE_CAP_MINUTES = 15;
type TaskActualsFlag = "no-impl-session" | "weak-link" | "multi-task" | "reopened" | "unpriced" | "unmapped-role";
/** A done task as the caller read it from its task store. */
interface ActualsTask {
    id: string;
    initiative: string;
    /** An ISO datetime, or a date alone for tasks written before the store kept the time. */
    doneAt: string | null;
}
interface TaskActualsOptions {
    /** Engineering initiatives to read. A task outside it never gets a row. */
    initiatives: readonly string[];
    /** The idle cap behind the headline hours; the 5 and 60 minute values always come alongside. */
    capMinutes?: number;
    /** Shepherd's per-run records; when passed, every row carries the Shepherd facts. */
    shepherdRuns?: readonly ShepherdRunRecord[];
    /** Where Shepherd's ledger begins; defaults to the earliest run. A row merged before it gets null Shepherd facts. */
    shepherdSince?: string;
}
/** Agent-hours at three idle caps. */
interface CappedHours {
    capped: number;
    at5m: number;
    at60m: number;
}
interface TaskPr {
    prRef: string;
    mergedAt: string | null;
}
interface TaskActuals {
    taskId: string;
    initiative: string;
    doneAt: string;
    implAgentHours: CappedHours;
    reviewAgentHours: CappedHours;
    usd: number;
    implSessions: number;
    firstImplAt: string | null;
    lastImplAt: string | null;
    prs: TaskPr[];
    /** Largest main-thread context over the implementer sessions; null when they have no requests. */
    peakContext: number | null;
    /** Context of the first implementer request at or after the first status_report or pr_create; null when there is none. */
    contextAtFirstDeliverable: number | null;
    /** Task-linked sessions that count toward neither total: a profile that is not an implementer or reviewer. */
    unmappedSessions: number;
    flags: TaskActualsFlag[];
    reviewRounds?: ShepherdFacts["reviewRounds"];
    stageMinutes?: ShepherdFacts["stageMinutes"];
    serviceWallHours?: ShepherdFacts["serviceWallHours"];
    mergePath?: ShepherdFacts["mergePath"];
}
/** One row per done task in the allowlist; a task no session links to still gets a row, flagged. */
declare function taskActuals(minerDb: Db, tasks: readonly ActualsTask[], options: TaskActualsOptions): TaskActuals[];

/** A named seat and the top-level sessions it ran as; the caller identifies them, this module does not. */
interface SeatSessions {
    name: string;
    sessionIds: readonly string[];
}
interface SeatContextOptions {
    window: ReportWindow;
    sessions: readonly SeatSessions[];
}
interface SeatContextRow {
    name: string;
    /** Main-thread requests in the window, each copy of a request counted once. */
    requests: number;
    p50: number;
    p90: number;
    max: number;
    compactions: {
        auto: number;
        manual: number;
    };
}
declare const seatContextSchema: z.ZodArray<z.ZodObject<{
    name: z.ZodString;
    requests: z.ZodNumber;
    p50: z.ZodNumber;
    p90: z.ZodNumber;
    max: z.ZodNumber;
    compactions: z.ZodObject<{
        auto: z.ZodNumber;
        manual: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>>;
/**
 * Context per call (input + cache read + cache write) for each seat over a window, with the
 * percentile taken as `v[floor(n * q)]` of the sorted values so it matches the ctx.py method.
 */
declare function seatContext(db: Db, options: SeatContextOptions): SeatContextRow[];

/**
 * The seat a transcript belongs to: the first user prompt saying `as seat <seat>`, or the first
 * `chat_register` call naming a seat. A sidechain record ends the scan, since a subagent file is no seat.
 */
declare function seatOf(lines: Iterable<string>, seats: readonly string[]): string | null;

type Trigger = "local-cmd" | "cron-heartbeat" | "boot" | "bg-task-notification" | "agent-chat system msg" | "peer-seat msg" | "operator/ram relay" | "own-agent report" | "one-shot-timer" | "owner/direct";
/** Turn outcomes in priority order: a turn's outcome is the first one any of its tools hits. */
declare const OUTCOMES: readonly ["dispatch", "merge", "retire", "task", "peer-reply", "file-write", "teleport"];
type Outcome = (typeof OUTCOMES)[number] | "NO-OP";

type DutyKind = "det" | "judge" | "half" | "handoff" | "incident" | "other";
/** Matches the full command text; the first matching rule wins, so the order is part of the method. */
interface BashRule {
    id: string;
    pattern: RegExp;
    /** Must also match. */
    also?: RegExp;
    /** Must not match. */
    unless?: RegExp;
    duty: string;
}
/** A tool input field a rule reads. `to` takes the first recipient of a list. */
type ToolField = "name" | "message" | "to" | "file_path";
interface ToolRule {
    id: string;
    /** Exact tool names, or `*suffix` for an MCP tool under any server prefix. */
    tools: readonly string[];
    when?: {
        field: ToolField;
        pattern: RegExp;
        also?: RegExp;
    } | {
        field: "to";
        recipient: "owner";
    };
    /** null stops the scan with the call left unclassified. */
    duty: string | null;
}
interface DutyRuleSet {
    id: string;
    bash: readonly BashRule[];
    tools: readonly ToolRule[];
    /** The duty of an unclassified call in a turn with no classified call; a missing trigger falls to `other`. */
    triggerDefaults: Partial<Record<Trigger, string>>;
}

/**
 * How an unclassified call inherits a duty: `dominant` takes the turn's highest-dollar classified duty
 * (TP-1550); `nearest` takes the nearest earlier classified call in the turn (the deep dive's default,
 * because a basement heartbeat batches about a dozen calls).
 */
type InheritMode = "dominant" | "nearest";

/** One file of a seat session. A session can have several copies: two profiles, or a mirror. */
interface TranscriptCopy {
    seat: string;
    sessionId: string;
    /** Orders the copies of a session, largest first. */
    size: number;
    /** Window start for this copy's pool; the pools moved accounts at different times. */
    lo: string;
    lines: Iterable<string>;
}
type CacheWriteTtl = "5m" | "1h";
/**
 * Owner decision D2: a cache write with no 5m/1h split prices at the 5m rate, as `priceRequest`
 * does. agent_usage.py, which TP-1550 priced with, used 1h; pass `splitlessCacheWrite: "1h"` for its delta.
 */
declare const SPLITLESS_CACHE_WRITE_TTL: CacheWriteTtl;
interface MeterOptions {
    /** Window end, exclusive. */
    hi: string;
    rules: DutyRuleSet;
    inherit: InheritMode;
    /** Operator sessions: their channel messages and pane text are relays. */
    ops: readonly string[];
    /** Recipient prefixes counted as owner communication. */
    owners: readonly string[];
    splitlessCacheWrite?: CacheWriteTtl;
    prices?: readonly PriceRow[];
}
interface DutyCall {
    seat: string;
    /** The 8-char session prefix. */
    sid: string;
    ts: string;
    usd: number;
    duty: string;
    raw: string | null;
    trig: Trigger;
    outcome: Outcome;
    /** The start of the call's turn. */
    turn: string;
    /** The first tool's command, or `<tool> <json input>`. */
    ex: string;
}
interface DutyTurn {
    seat: string;
    ts: string;
    trig: Trigger;
    outcome: Outcome;
    usd: number;
    calls: number;
    head: string;
}
interface MeterInputs {
    transcripts: number;
    sessions: number;
    /** Copies past the first of a session. */
    dupCopies: number;
    /** Calls whose model has no price row, costed at 0 and counted here so the gap is visible. */
    unpriced: number;
    unpricedModels: Record<string, number>;
    /** Calls with a cache write but no 5m/1h split, priced at the splitless rate. */
    splitlessCacheWrites: number;
}
interface MeterResult {
    calls: DutyCall[];
    turns: DutyTurn[];
    inputs: MeterInputs;
}
/**
 * Meters seat transcripts. Copies of a session run largest first, and a message id is priced
 * only the first time it is seen, so a smaller copy adds only what the larger one lacks; it is
 * never taken for a prefix. A turn counts only if it holds a newly priced call.
 */
declare function mergeCopies(copies: readonly TranscriptCopy[], options: MeterOptions): MeterResult;

/** The 2026-10-04 TP-1550 rules, copied from duty2.py in order. Kept as the baseline the v3 rules are compared against. */
declare const TP1550_RULES: DutyRuleSet;

/** The 2026-10-09 deep-dive rules (duty3.py; method doc 3a/3b), B1-B21 then T1-T15 in order. */
declare const V3_RULES: DutyRuleSet;

/** The duty-table subset of the `titan.coord-duty/v1` report (method doc section 4). */
declare const coordDutyTableSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan.coord-duty/v1">;
    window: z.ZodObject<{
        lo: z.ZodString;
        hi: z.ZodString;
        hours: z.ZodNumber;
    }, z.core.$strip>;
    seats: z.ZodArray<z.ZodString>;
    inputs: z.ZodObject<{
        transcripts: z.ZodNumber;
        sessions: z.ZodNumber;
        dupCopies: z.ZodNumber;
        unpriced: z.ZodNumber;
        unpricedModels: z.ZodRecord<z.ZodString, z.ZodNumber>;
        splitlessCacheWrites: z.ZodNumber;
        priceTableVersion: z.ZodString;
        rules: z.ZodString;
    }, z.core.$strip>;
    totals: z.ZodObject<{
        calls: z.ZodNumber;
        usd: z.ZodNumber;
        turns: z.ZodNumber;
        mergedPrs: z.ZodNullable<z.ZodNumber>;
        usdPerPr: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>;
    duties: z.ZodArray<z.ZodObject<{
        duty: z.ZodString;
        kind: z.ZodEnum<{
            other: "other";
            handoff: "handoff";
            det: "det";
            judge: "judge";
            half: "half";
            incident: "incident";
        }>;
        group: z.ZodString;
        calls: z.ZodNumber;
        usd: z.ZodNumber;
        share: z.ZodNumber;
        usdPerPr: z.ZodNullable<z.ZodNumber>;
        perSeat: z.ZodRecord<z.ZodString, z.ZodNumber>;
    }, z.core.$strip>>;
    triggers: z.ZodArray<z.ZodObject<{
        trigger: z.ZodString;
        turns: z.ZodNumber;
        noop: z.ZodNumber;
        usd: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
type CoordDutyTable = z.infer<typeof coordDutyTableSchema>;
interface DutyTableOptions {
    /** The overall window; with per-pool starts, `lo` is the earliest. */
    window: {
        lo: string;
        hi: string;
    };
    seats: readonly string[];
    rules: string;
    /** PRs merged in the window and attributed to the seats; null leaves $/PR unset. */
    mergedPrs: number | null;
}
/** The duty table, highest dollars first, with the trigger mix by turn. */
declare function dutyTable(result: MeterResult, options: DutyTableOptions): CoordDutyTable;

/** One line of a seat's `dispatch.jsonl`, with the seat taken from its directory and `at` in epoch ms. */
interface DispatchRecord {
    seat: string;
    at: number;
    ts: string;
    task?: string;
    pr?: string;
    outcome?: string;
    milestone?: string;
    note?: string;
    usd_est?: unknown;
}
type ScorecardJournalRowId = "rework" | "mechanical" | "autonomy" | "cost";
/** A scorecard row; `value` is null, never zero, when its source is absent or empty. */
interface ScorecardRow {
    id: string;
    metric: string;
    value: string | null;
    source: string;
    measured: boolean;
    /** Set on the cost row only: merged tasks with a retired usd_est, out of all merged tasks in the window. */
    coverage?: {
        tasksWithUsdEst: number;
        mergedTasks: number;
    };
}
interface ScorecardJournalInput {
    /** agent-chat's events.db, opened read-only by the caller; null when the file is absent. */
    eventsDb: Db | null;
    /** Every journal record, any window: the cost row sums spend from before the window. */
    dispatchRecords: readonly DispatchRecord[];
    since: string;
    now: string;
}
declare const NOT_MEASURED = "not measured";
/** Below this share of merged tasks carrying a retired usd_est, the cost row stays unmeasured so a sparse sample never prints. */
declare const MIN_COST_COVERAGE = 0.8;
/** Every record of each `<dir>/<seat>/dispatch.jsonl`; an absent dir or journal reads as none, and an unparseable line is skipped. */
declare function readDispatchJournal(dir: string): DispatchRecord[];
/** The scorecard rows read from events.db verdicts and seat dispatch journals, in scripts/seat/scorecard's order and wording. */
declare function scorecardJournalRows(input: ScorecardJournalInput): ScorecardRow[];
/** A row's value as the scorecard prints it: the cost row names its usd_est coverage whether or not it is measured. */
declare function scorecardRowText(r: ScorecardRow): string;

export { ACTION_CLASSES, AGENT_LIFECYCLE, ALL_REPOS, type ActionCall, type ActionClass, type ActionRule, type ActualsTask, type AgentNameRow, type Assignment, BLOCKED_FLOW_SOURCES, BOOT_TOOL, type Band, type BashRule, type BlockedFlowInput, type BlockedFlowReport, type BlockedFlowSource, type BrokerEntry, CHANNEL_CLUSTER_MS, CONTEXT_BANDS, CONTEXT_RESET_TOKENS, COORDINATOR_MERGE_DEDUPE_REQUESTS, COORDINATOR_MIN_EPISODE_REQUESTS, COORDINATOR_WAVE_QUIET_REQUESTS, COST_REPORT_SECTIONS, type CacheTtlBucket, type CacheTtlWhatIf, type CacheWriteTtl, type CappedHours, type CompactionMark, type CoordDutyTable, type CostBucket, type CostPerOutcomeOptions, type CostPerOutcomeReport, type CostReport, type CostReportOptions, type CostReportSection, type CycleParams, DARK_MIN, DEFAULT_ACTION_RULES, DEFAULT_ACTIVE_CAP_MINUTES, DEFAULT_BOOT_REQUESTS, DEFAULT_CONFIGURED_K, DEFAULT_EPISODE_ROLES, DEFAULT_K_SWEEP, DEFAULT_MECHANICAL_CLASSES, DEFAULT_NO_ACTION_CLASSES, DEFAULT_REVIEWER_PRS, DEFAULT_REVIEWER_ROLE, DEFAULT_STANDING_ROLE, type DarkGap, type DenialRecord, type DispatchRecord, type DutyCall, type DutyKind, type DutyRuleSet, type DutyTableOptions, type DutyTurn, EVENTS_TABLE_DDL, type EpisodeInbound, type EpisodeInput, type EpisodeNames, type EpisodeRequest, type EpisodeRequestRow, type EpisodeSignal, GAP_BANDS, type GenerationEnd, HANDOFFS_SQL, HEURISTIC_VERSIONS, type HandoffCohort, type HandoffOptions, type HandoffRecord, type HandoffRequestRow, type HandoffSession, type HandoffTeleport, type HandoffThreshold, type Heuristic, type HumanRole, IDLE_GAP_MS, type IdleSlotRow, type InheritMode, type KSweep, LAST_PROMPTS_SQL, LIST_PRICE_CAVEAT, LIVENESS_SOURCES, type LastEventRecord, type LatencyRow, type LatencyStats, type LivenessInput, type LivenessReport, type LivenessSource, MIN_COST_COVERAGE, type MechanicalShare, type MergeOutcome, type MergeStatus, type MeterInputs, type MeterOptions, type MeterResult, type ModelRequests, NOT_MEASURED, type Outcome, type OutcomeBucket, POOLED_REVIEWERS, PRICE_TABLE, PRICE_TABLE_VERSION, PROFILE_ROLES, PROMPT_STALE_MIN, type ParsedVerdict, type PriceRow, type PricedRequest, type PullState, REBUILD_GAP_BANDS, type ReportScope, type ReportWindow, type RequestTokens, type ReviewFillReport, type ReviewerComparison, type RoleActions, type RouteFailureRow, type RouteMiss, type RouteMissKind, SESSION_TIMELINE_VERSION, SPAWNS_SQL, SPLITLESS_CACHE_WRITE_TTL, STANDING_PEER_MIN_ASSIGNMENTS, STANDING_PEER_MIN_HOURS, type ScorecardJournalInput, type ScorecardJournalRowId, type ScorecardRow, type SeatContextOptions, type SeatContextRow, type SeatGeneration, type SeatGenerationsInput, type SeatJournal, type SeatSessions, type SessionClass, type SessionClassification, type SessionFacts, type SessionOrigin, type SessionTimeline, SessionTimelineAccumulator, type SessionTimelineOptions, type SlotTick, type SpawnRecord, type StalePromptRow, type SuccessorReworkOptions, type SuccessorReworkReport, TELEPORT_COMPLETED_EVENT, TELEPORT_EVENT, TICK_HOLD_MAX_MIN, TIMELINE_GAP_MIN_MS, TIMELINE_TEXT_CAP, TOKEN_CLASSES, TP1550_RULES, type TaskActuals, type TaskActualsFlag, type TaskActualsOptions, type TaskInitiative, type TaskPr, type TeleportEvent, type TimelineAgentSpan, type TimelineError, type TimelineErrorBreakdown, type TimelineFileBreakdown, type TimelineFileTouch, type TimelineGap, type TimelineMessage, type TimelineMinuteBucket, type TimelineTokenPoint, type TimelineTokens, type TimelineToolBreakdown, type TimelineToolCall, type TimelineToolOutcome, type TimelineTotals, type TimelineTurn, type TimelineTurnOrigin, type TokenClass, type TokenTimeline, type ToolFamilyCount, type ToolField, type ToolNameCount, type ToolRule, type TranscriptCopy, type Trigger, type TtlRequestRow, UNKNOWN_PROFILE, UNSTATED_REASON, type UnreportedExit, type UnreportedExitRow, V3_RULES, VERDICTS_SQL, type VerdictRecord, WAKE_FROM_KINDS, type WakeCauseBucket, type WakeCauseEpisodes, type WakeEpisode, type WakeEpisodes, type WakeEventRow, type WakeFromKind, type WakeGapCell, type WakePair, type WorkerFacts, type WorkerRole, type WrittenEpisodes, assignmentCount, assignmentSchema, bandOf, blockedFlowReport, blockedFlowSchema, buildEpisodes, buildSessionTimeline, buildWakeEpisodes, cacheTtlReport, cacheTtlWhatIf, cacheTtlWhatIfSchema, classifyDeniedAction, classifyRequest, classifySession, contextBand, coordDutyTableSchema, costPerOutcome, costPerOutcomeSchema, costPerRequest, costReport, costReportSchema, countAtOrBefore, countMisses, darkGaps, dedupeDenials, dutyTable, episodeNames, eventsDbCommand, findPrice, gapBand, handoffThreshold, handoffThresholdSchema, heuristicFor, idleSlotMinutes, initiativeFromCwd, isBootAction, latencyStats, latencyStatsSchema, livenessReport, livenessSchema, mergeCopies, mergeOutcomes, parseBrokerLog, parseDenials, parseSeatJournal, parseTeleportEvents, parseVerdict, prKey, priceRequest, readAgentSessions, readDispatchJournal, readEpisodeInput, readHandoffs, readLastPrompts, readRequestToolCalls, readSpawns, readTtlRows, readVerdicts, renderBlockedFlowText, renderCacheTtlText, renderCostPerOutcomeText, renderCostReportSections, renderCostReportText, renderLivenessText, reviewFillReport, reviewFillSchema, roleFromProfile, routeFailureRows, routeMisses, scopeFilter, scorecardJournalRows, scorecardRowText, seatContext, seatContextSchema, seatGenerations, seatGenerationsSchema, seatOf, sessionInitiative, sessionRole, staleEpisodeSessions, stalePromptRows, successorReworkReport, successorReworkSchema, summarizeWakeEpisodes, sweepK, taskActuals, unreportedExitRows, wakeEpisodesSchema, workerRole, writeEpisodes };
