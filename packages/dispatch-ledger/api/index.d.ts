import { z } from 'zod';
import { Db, Migration } from '@titan-design/store-sqlite';

/**
 * The burndown claim ledger: which task each tick-spawned agent holds.
 *
 * A claim holds its task until its phase is `done`, and a lane only while an agent works on it. A stalled claim (a
 * `stalledReason`, or past its phase timeout) keeps both: it is filed to the backlog rather than respawned.
 */
declare const PHASES: readonly ["queued", "spawning", "planning", "implementing", "parked", "reviewing", "awaiting-merge", "shepherding", "done"];
type Phase = (typeof PHASES)[number];
/** Phases a spawn lands in once its agent row appears. */
declare const AGENT_PHASES: readonly ["planning", "implementing", "reviewing"];
type AgentPhase = (typeof AGENT_PHASES)[number];
/** The unmerged parent slice a claim was admitted on, and the parent PR's head branch. */
declare const StackedOnSchema: z.ZodObject<{
    taskId: z.ZodString;
    slice: z.ZodString;
    pr: z.ZodString;
    branch: z.ZodString;
}, z.core.$strip>;
type StackedOn = z.infer<typeof StackedOnSchema>;
declare const ClaimSchema: z.ZodObject<{
    stalledReason: z.ZodOptional<z.ZodString>;
    stalledClass: z.ZodOptional<z.ZodEnum<{
        stalled: "stalled";
        failed: "failed";
        "gate-trip": "gate-trip";
    }>>;
    stallCode: z.ZodOptional<z.ZodEnum<{
        "spawn-never-landed": "spawn-never-landed";
        "shepherd-ended": "shepherd-ended";
        "planner-refused": "planner-refused";
        "retry-spent": "retry-spent";
        budget: "budget";
        "outside-owns": "outside-owns";
        "phase-timeout": "phase-timeout";
        "dirty-uncommitted": "dirty-uncommitted";
        "lease-expired": "lease-expired";
        "no-progress": "no-progress";
    }>>;
    stalledAt: z.ZodOptional<z.ZodString>;
    stale: z.ZodOptional<z.ZodObject<{
        class: z.ZodEnum<{
            "retry-spent": "retry-spent";
            "outside-owns": "outside-owns";
            "nothing-to-do": "nothing-to-do";
            "date-blocked": "date-blocked";
            "pr-closed": "pr-closed";
            blocked: "blocked";
            timeout: "timeout";
            other: "other";
        }>;
        proposed: z.ZodString;
        since: z.ZodString;
        until: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    respawn: z.ZodOptional<z.ZodObject<{
        code: z.ZodEnum<{
            "spawn-never-landed": "spawn-never-landed";
            "shepherd-ended": "shepherd-ended";
            "planner-refused": "planner-refused";
            "retry-spent": "retry-spent";
            budget: "budget";
            "outside-owns": "outside-owns";
            "phase-timeout": "phase-timeout";
            "dirty-uncommitted": "dirty-uncommitted";
            "lease-expired": "lease-expired";
            "no-progress": "no-progress";
        }>;
        occurrence: z.ZodString;
    }, z.core.$strip>>;
    unretired: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        reason: z.ZodString;
        at: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    notified: z.ZodOptional<z.ZodArray<z.ZodString>>;
    noticeFacts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    finding: z.ZodOptional<z.ZodObject<{
        kind: z.ZodLiteral<"stalled-after-claim">;
        reason: z.ZodEnum<{
            silent: "silent";
            idle: "idle";
            "slow-tool": "slow-tool";
            lease: "lease";
        }>;
        code: z.ZodOptional<z.ZodEnum<{
            "spawn-never-landed": "spawn-never-landed";
            "shepherd-ended": "shepherd-ended";
            "planner-refused": "planner-refused";
            "retry-spent": "retry-spent";
            budget: "budget";
            "outside-owns": "outside-owns";
            "phase-timeout": "phase-timeout";
            "dirty-uncommitted": "dirty-uncommitted";
            "lease-expired": "lease-expired";
            "no-progress": "no-progress";
        }>>;
        since: z.ZodString;
        openedAt: z.ZodString;
        checkedAt: z.ZodString;
        detail: z.ZodString;
    }, z.core.$strip>>;
    checkpoint: z.ZodOptional<z.ZodObject<{
        sentAt: z.ZodOptional<z.ZodString>;
        failed: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    lease: z.ZodOptional<z.ZodObject<{
        progressAt: z.ZodString;
        leaseUntil: z.ZodString;
        renewals: z.ZodNumber;
        head: z.ZodOptional<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
        transcriptAt: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    leak: z.ZodOptional<z.ZodObject<{
        repo: z.ZodString;
        url: z.ZodString;
        findings: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    triage: z.ZodOptional<z.ZodObject<{
        occurrence: z.ZodString;
        since: z.ZodString;
        outcome: z.ZodEnum<{
            waiting: "waiting";
            started: "started";
            refused: "refused";
            ended: "ended";
            fallback: "fallback";
        }>;
        name: z.ZodOptional<z.ZodString>;
        startedAt: z.ZodOptional<z.ZodString>;
        detail: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    taskId: z.ZodString;
    initiative: z.ZodString;
    agentId: z.ZodOptional<z.ZodString>;
    spawnedAt: z.ZodString;
    phase: z.ZodEnum<{
        queued: "queued";
        spawning: "spawning";
        planning: "planning";
        implementing: "implementing";
        parked: "parked";
        reviewing: "reviewing";
        "awaiting-merge": "awaiting-merge";
        shepherding: "shepherding";
        done: "done";
    }>;
    phaseAt: z.ZodString;
    slice: z.ZodOptional<z.ZodString>;
    dependsOn: z.ZodOptional<z.ZodArray<z.ZodString>>;
    stackedOn: z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
        slice: z.ZodString;
        pr: z.ZodString;
        branch: z.ZodString;
    }, z.core.$strip>>;
    owns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    ownsAmended: z.ZodOptional<z.ZodArray<z.ZodString>>;
    repo: z.ZodOptional<z.ZodString>;
    contracts: z.ZodOptional<z.ZodArray<z.ZodObject<{
        scope: z.ZodString;
        op: z.ZodEnum<{
            replace: "replace";
            remove: "remove";
            rename: "rename";
            migrate: "migrate";
            add: "add";
            extend: "extend";
            modify: "modify";
        }>;
    }, z.core.$strip>>>;
    agentName: z.ZodOptional<z.ZodString>;
    spawned: z.ZodOptional<z.ZodArray<z.ZodString>>;
    nextPhase: z.ZodOptional<z.ZodEnum<{
        planning: "planning";
        implementing: "implementing";
        reviewing: "reviewing";
    }>>;
    briefer: z.ZodOptional<z.ZodBoolean>;
    worktree: z.ZodOptional<z.ZodString>;
    questionId: z.ZodOptional<z.ZodString>;
    inboxCursor: z.ZodOptional<z.ZodString>;
    attempt: z.ZodOptional<z.ZodNumber>;
    resumed: z.ZodOptional<z.ZodLiteral<true>>;
    reviewRound: z.ZodOptional<z.ZodNumber>;
    pr: z.ZodOptional<z.ZodString>;
    prHead: z.ZodOptional<z.ZodString>;
    lastReport: z.ZodOptional<z.ZodString>;
    seat: z.ZodOptional<z.ZodString>;
    namePrefix: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
type Claim = z.infer<typeof ClaimSchema>;
declare const DeciderStateSchema: z.ZodObject<{
    wakes: z.ZodArray<z.ZodString>;
    refused: z.ZodOptional<z.ZodObject<{
        reason: z.ZodString;
        at: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
type DeciderState = z.infer<typeof DeciderStateSchema>;
declare const SeatStateSchema: z.ZodObject<{
    samples: z.ZodArray<z.ZodObject<{
        at: z.ZodNumber;
        sevenDay: z.ZodNumber;
        resetsAt: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    configDir: z.ZodOptional<z.ZodString>;
    noDispatch: z.ZodOptional<z.ZodObject<{
        key: z.ZodString;
        at: z.ZodString;
    }, z.core.$strip>>;
    exhaustedTicks: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type SeatState = z.infer<typeof SeatStateSchema>;
/** How often a task was released and when last; the dispatcher turns it into a hold. */
declare const ReleaseRecordSchema: z.ZodObject<{
    n: z.ZodNumber;
    at: z.ZodString;
}, z.core.$strip>;
type ReleaseRecord = z.infer<typeof ReleaseRecordSchema>;
/** Failures of one action for one claim, counted per fact fingerprint. */
declare const LivenessRecordSchema: z.ZodObject<{
    byFact: z.ZodRecord<z.ZodString, z.ZodObject<{
        n: z.ZodNumber;
        firstAt: z.ZodString;
        lastAt: z.ZodString;
        lastText: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
type LivenessRecord = z.infer<typeof LivenessRecordSchema>;
/** A claim's place on the triage ladder; kept on the ledger, apart from `attempt` and `reviewRound`. */
declare const LadderRecordSchema: z.ZodObject<{
    respawns: z.ZodNumber;
    lastAt: z.ZodString;
    occurrence: z.ZodOptional<z.ZodString>;
    owner: z.ZodOptional<z.ZodString>;
    releases: z.ZodOptional<z.ZodNumber>;
    branch: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodEnum<{
        "spawn-never-landed": "spawn-never-landed";
        "shepherd-ended": "shepherd-ended";
        "planner-refused": "planner-refused";
        "retry-spent": "retry-spent";
        budget: "budget";
        "outside-owns": "outside-owns";
        "phase-timeout": "phase-timeout";
        "dirty-uncommitted": "dirty-uncommitted";
        "lease-expired": "lease-expired";
        "no-progress": "no-progress";
    }>>;
    seat: z.ZodOptional<z.ZodString>;
    releaseDue: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strip>;
type LadderRecord = z.infer<typeof LadderRecordSchema>;
/** The ladder's mass-death brake: occurrence times inside the window, and the notice sent for this brake. */
declare const BrakeStateSchema: z.ZodObject<{
    at: z.ZodArray<z.ZodString>;
    notified: z.ZodOptional<z.ZodString>;
    claims: z.ZodOptional<z.ZodArray<z.ZodString>>;
    seen: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
type BrakeState = z.infer<typeof BrakeStateSchema>;
/** A seat's run of refused deliveries; `skipped` counts the ticks a stopped seat was held back since its last probe. */
declare const WakeRecordSchema: z.ZodObject<{
    failed: z.ZodNumber;
    reason: z.ZodOptional<z.ZodString>;
    skipped: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type WakeRecord = z.infer<typeof WakeRecordSchema>;
declare const LedgerSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    lastTickAt: z.ZodOptional<z.ZodString>;
    claims: z.ZodArray<z.ZodObject<{
        stalledReason: z.ZodOptional<z.ZodString>;
        stalledClass: z.ZodOptional<z.ZodEnum<{
            stalled: "stalled";
            failed: "failed";
            "gate-trip": "gate-trip";
        }>>;
        stallCode: z.ZodOptional<z.ZodEnum<{
            "spawn-never-landed": "spawn-never-landed";
            "shepherd-ended": "shepherd-ended";
            "planner-refused": "planner-refused";
            "retry-spent": "retry-spent";
            budget: "budget";
            "outside-owns": "outside-owns";
            "phase-timeout": "phase-timeout";
            "dirty-uncommitted": "dirty-uncommitted";
            "lease-expired": "lease-expired";
            "no-progress": "no-progress";
        }>>;
        stalledAt: z.ZodOptional<z.ZodString>;
        stale: z.ZodOptional<z.ZodObject<{
            class: z.ZodEnum<{
                "retry-spent": "retry-spent";
                "outside-owns": "outside-owns";
                "nothing-to-do": "nothing-to-do";
                "date-blocked": "date-blocked";
                "pr-closed": "pr-closed";
                blocked: "blocked";
                timeout: "timeout";
                other: "other";
            }>;
            proposed: z.ZodString;
            since: z.ZodString;
            until: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        respawn: z.ZodOptional<z.ZodObject<{
            code: z.ZodEnum<{
                "spawn-never-landed": "spawn-never-landed";
                "shepherd-ended": "shepherd-ended";
                "planner-refused": "planner-refused";
                "retry-spent": "retry-spent";
                budget: "budget";
                "outside-owns": "outside-owns";
                "phase-timeout": "phase-timeout";
                "dirty-uncommitted": "dirty-uncommitted";
                "lease-expired": "lease-expired";
                "no-progress": "no-progress";
            }>;
            occurrence: z.ZodString;
        }, z.core.$strip>>;
        unretired: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            reason: z.ZodString;
            at: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        notified: z.ZodOptional<z.ZodArray<z.ZodString>>;
        noticeFacts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        finding: z.ZodOptional<z.ZodObject<{
            kind: z.ZodLiteral<"stalled-after-claim">;
            reason: z.ZodEnum<{
                silent: "silent";
                idle: "idle";
                "slow-tool": "slow-tool";
                lease: "lease";
            }>;
            code: z.ZodOptional<z.ZodEnum<{
                "spawn-never-landed": "spawn-never-landed";
                "shepherd-ended": "shepherd-ended";
                "planner-refused": "planner-refused";
                "retry-spent": "retry-spent";
                budget: "budget";
                "outside-owns": "outside-owns";
                "phase-timeout": "phase-timeout";
                "dirty-uncommitted": "dirty-uncommitted";
                "lease-expired": "lease-expired";
                "no-progress": "no-progress";
            }>>;
            since: z.ZodString;
            openedAt: z.ZodString;
            checkedAt: z.ZodString;
            detail: z.ZodString;
        }, z.core.$strip>>;
        checkpoint: z.ZodOptional<z.ZodObject<{
            sentAt: z.ZodOptional<z.ZodString>;
            failed: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        lease: z.ZodOptional<z.ZodObject<{
            progressAt: z.ZodString;
            leaseUntil: z.ZodString;
            renewals: z.ZodNumber;
            head: z.ZodOptional<z.ZodString>;
            content: z.ZodOptional<z.ZodString>;
            transcriptAt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        leak: z.ZodOptional<z.ZodObject<{
            repo: z.ZodString;
            url: z.ZodString;
            findings: z.ZodArray<z.ZodString>;
        }, z.core.$strip>>;
        triage: z.ZodOptional<z.ZodObject<{
            occurrence: z.ZodString;
            since: z.ZodString;
            outcome: z.ZodEnum<{
                waiting: "waiting";
                started: "started";
                refused: "refused";
                ended: "ended";
                fallback: "fallback";
            }>;
            name: z.ZodOptional<z.ZodString>;
            startedAt: z.ZodOptional<z.ZodString>;
            detail: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        taskId: z.ZodString;
        initiative: z.ZodString;
        agentId: z.ZodOptional<z.ZodString>;
        spawnedAt: z.ZodString;
        phase: z.ZodEnum<{
            queued: "queued";
            spawning: "spawning";
            planning: "planning";
            implementing: "implementing";
            parked: "parked";
            reviewing: "reviewing";
            "awaiting-merge": "awaiting-merge";
            shepherding: "shepherding";
            done: "done";
        }>;
        phaseAt: z.ZodString;
        slice: z.ZodOptional<z.ZodString>;
        dependsOn: z.ZodOptional<z.ZodArray<z.ZodString>>;
        stackedOn: z.ZodOptional<z.ZodObject<{
            taskId: z.ZodString;
            slice: z.ZodString;
            pr: z.ZodString;
            branch: z.ZodString;
        }, z.core.$strip>>;
        owns: z.ZodOptional<z.ZodArray<z.ZodString>>;
        ownsAmended: z.ZodOptional<z.ZodArray<z.ZodString>>;
        repo: z.ZodOptional<z.ZodString>;
        contracts: z.ZodOptional<z.ZodArray<z.ZodObject<{
            scope: z.ZodString;
            op: z.ZodEnum<{
                replace: "replace";
                remove: "remove";
                rename: "rename";
                migrate: "migrate";
                add: "add";
                extend: "extend";
                modify: "modify";
            }>;
        }, z.core.$strip>>>;
        agentName: z.ZodOptional<z.ZodString>;
        spawned: z.ZodOptional<z.ZodArray<z.ZodString>>;
        nextPhase: z.ZodOptional<z.ZodEnum<{
            planning: "planning";
            implementing: "implementing";
            reviewing: "reviewing";
        }>>;
        briefer: z.ZodOptional<z.ZodBoolean>;
        worktree: z.ZodOptional<z.ZodString>;
        questionId: z.ZodOptional<z.ZodString>;
        inboxCursor: z.ZodOptional<z.ZodString>;
        attempt: z.ZodOptional<z.ZodNumber>;
        resumed: z.ZodOptional<z.ZodLiteral<true>>;
        reviewRound: z.ZodOptional<z.ZodNumber>;
        pr: z.ZodOptional<z.ZodString>;
        prHead: z.ZodOptional<z.ZodString>;
        lastReport: z.ZodOptional<z.ZodString>;
        seat: z.ZodOptional<z.ZodString>;
        namePrefix: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    decider: z.ZodOptional<z.ZodObject<{
        wakes: z.ZodArray<z.ZodString>;
        refused: z.ZodOptional<z.ZodObject<{
            reason: z.ZodString;
            at: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    seats: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        samples: z.ZodArray<z.ZodObject<{
            at: z.ZodNumber;
            sevenDay: z.ZodNumber;
            resetsAt: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strip>>;
        configDir: z.ZodOptional<z.ZodString>;
        noDispatch: z.ZodOptional<z.ZodObject<{
            key: z.ZodString;
            at: z.ZodString;
        }, z.core.$strip>>;
        exhaustedTicks: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
    humanFiled: z.ZodOptional<z.ZodArray<z.ZodString>>;
    leakScanner: z.ZodOptional<z.ZodString>;
    leakScans: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        text: z.ZodOptional<z.ZodArray<z.ZodString>>;
        branch: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    releases: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        n: z.ZodNumber;
        at: z.ZodString;
    }, z.core.$strip>>>;
    slicesReleased: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
    triageStarts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    liveness: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        byFact: z.ZodRecord<z.ZodString, z.ZodObject<{
            n: z.ZodNumber;
            firstAt: z.ZodString;
            lastAt: z.ZodString;
            lastText: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
    ladder: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        respawns: z.ZodNumber;
        lastAt: z.ZodString;
        occurrence: z.ZodOptional<z.ZodString>;
        owner: z.ZodOptional<z.ZodString>;
        releases: z.ZodOptional<z.ZodNumber>;
        branch: z.ZodOptional<z.ZodString>;
        code: z.ZodOptional<z.ZodEnum<{
            "spawn-never-landed": "spawn-never-landed";
            "shepherd-ended": "shepherd-ended";
            "planner-refused": "planner-refused";
            "retry-spent": "retry-spent";
            budget: "budget";
            "outside-owns": "outside-owns";
            "phase-timeout": "phase-timeout";
            "dirty-uncommitted": "dirty-uncommitted";
            "lease-expired": "lease-expired";
            "no-progress": "no-progress";
        }>>;
        seat: z.ZodOptional<z.ZodString>;
        releaseDue: z.ZodOptional<z.ZodLiteral<true>>;
    }, z.core.$strip>>>;
    brake: z.ZodOptional<z.ZodObject<{
        at: z.ZodArray<z.ZodString>;
        notified: z.ZodOptional<z.ZodString>;
        claims: z.ZodOptional<z.ZodArray<z.ZodString>>;
        seen: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    serviceCheck: z.ZodOptional<z.ZodObject<{
        at: z.ZodString;
        cause: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>>;
    wake: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        failed: z.ZodNumber;
        reason: z.ZodOptional<z.ZodString>;
        skipped: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
type Ledger = z.infer<typeof LedgerSchema>;
declare const EMPTY_LEDGER: Ledger;
declare const PHASE_TIMEOUT_MS: Partial<Record<Phase, number>>;

/**
 * The closed set of codes a stall or a stalled-after-claim finding carries, in precedence order: when two hold, the
 * earlier wins. A stall outside these kinds keeps its `stalledClass` and carries no code.
 */
declare const STALL_CODES: readonly ["spawn-never-landed", "shepherd-ended", "planner-refused", "retry-spent", "budget", "outside-owns", "phase-timeout", "dirty-uncommitted", "lease-expired", "no-progress"];
type StallCode = (typeof STALL_CODES)[number];
/**
 * Codes a respawn or release can fix. The others go straight to the owner: a respawn under `budget` would spend more,
 * and `outside-owns` holds until the PR drops the file.
 */
declare const LADDER_CODES: readonly StallCode[];
/** What a stalled claim whose agent is gone is waiting on. */
declare const STALE_CLASSES: readonly ["nothing-to-do", "date-blocked", "retry-spent", "pr-closed", "blocked", "outside-owns", "timeout", "other"];
type StaleClass = (typeof STALE_CLASSES)[number];
/** Why a claim stopped, which decides who may handle it. A gate-trip is an owner gate and is never triaged. */
declare const EXCEPTION_CLASSES: readonly ["stalled", "failed", "gate-trip"];
type ExceptionClass = (typeof EXCEPTION_CLASSES)[number];
declare const CONTRACT_OPS: readonly ["replace", "remove", "rename", "migrate", "add", "extend", "modify"];
type ContractOp = (typeof CONTRACT_OPS)[number];
declare const DESTRUCTIVE_OPS: readonly ContractOp[];
declare const ContractSchema: z.ZodObject<{
    scope: z.ZodString;
    op: z.ZodEnum<{
        replace: "replace";
        remove: "remove";
        rename: "rename";
        migrate: "migrate";
        add: "add";
        extend: "extend";
        modify: "modify";
    }>;
}, z.core.$strip>;
type Contract = z.infer<typeof ContractSchema>;

/**
 * The claim-phase transition table: every (from, to) phase edge the burndown can emit, checked when the ledger is
 * written. An edge not here is refused; there is no force path. A write that keeps a claim's phase is not an edge,
 * and reading a ledger checks nothing.
 *
 * A spawn's landing and an undone spawn both leave `spawning`; a release sends any held phase to `queued`. A queued
 * slice finishes when the PR it is linked to merges.
 */
declare const PHASE_EDGES: Readonly<Record<Phase, readonly Phase[]>>;
/** Thrown by a ledger write that would take an edge outside `PHASE_EDGES`; the caller logs it. */
declare class IllegalPhaseEdgeError extends Error {
    name: string;
}
interface IllegalEdge {
    claim: string;
    from: Phase;
    to: Phase;
}
type Held = Pick<Claim, "taskId" | "slice" | "phase">;
/** The phase changes from `before` to `after` that the table does not allow. */
declare function illegalEdges(before: readonly Held[], after: readonly Held[]): IllegalEdge[];
/** The error a write throws for its first illegal edge, or undefined when every edge is in the table. */
declare function illegalEdgeError(before: readonly Held[], after: readonly Held[]): IllegalPhaseEdgeError | undefined;

/** A claim's identity: one claim per `(task, slice)` while it is held. */
type ClaimKey = Pick<Claim, "taskId" | "slice">;
declare const claimKey: (c: ClaimKey) => string;
declare const heldClaims: (ledger: Ledger) => Claim[];
/** Claims with an agent at work: parked, queued, awaiting-merge and shepherding claims hold their task but not a lane. */
declare const laneClaims: (ledger: Ledger) => Claim[];
/** The seat's claims the ledger shows holding an implementer: implementing, or spawning into it. */
declare const ledgerImplementers: (ledger: Ledger, seat: string) => number;
/** How many claims the ledger may hold beyond the agents actually running before the count is flagged. */
declare const SLOT_MISMATCH_TOLERANCE = 3;
/** The flag shown beside a role count whose ledger runs more than the tolerance ahead of its live agents. */
declare const slotMismatch: (ledger: number, live: number) => string | undefined;
declare function isStalled(claim: Claim, now: Date): boolean;
declare const sameClaim: (a: ClaimKey, b: ClaimKey) => boolean;
/** A second claim on a held `(task, slice)` is refused rather than merged. */
declare function addClaim(ledger: Ledger, claim: Claim): Ledger;
/** The parent a queued slice may stack on for its one unmet dependency `dep`, else undefined. */
type StackPredicate = (child: Claim, dep: string) => StackedOn | undefined;
/**
 * Queued slices whose dependencies are all done or released, whose task is not in `held`, and that no
 * hand-dispatched PR is linked to, in ledger order. With `stack`, a slice with exactly one unmet dependency is
 * ready too when `stack` admits it, and comes back carrying `stackedOn`.
 */
declare function readySlices(ledger: Ledger, held?: ReadonlyMap<string, unknown>, stack?: StackPredicate): Claim[];

type ClaimPatch = Partial<Omit<Claim, "taskId" | "slice" | "initiative">>;
/**
 * Ladder rung 2: the claim lets go of its worktree and branch, which stay. A slice goes back to `queued` for the
 * planner's work to survive; a whole task is dropped. Never clears `ledger.liveness`.
 */
interface ReleaseAction {
    kind: "release";
    key: ClaimKey;
    branch?: string;
    requeue: boolean;
    code: StallCode;
    /** The agents that may still run, newest first; a retired one is no longer the broker's to retire. */
    names: string[];
}
/**
 * The actions `applyActions` reads, plus the side-effect kinds it passes through unchanged. A product's own action
 * union, whose spawn, retire and register carry product types, stays assignable to this one.
 */
type LedgerAction = {
    kind: "update";
    key: ClaimKey;
    patch: ClaimPatch;
} | {
    kind: "add";
    claims: Claim[];
}
/** Writes the claim's triage ladder record; absent prunes it. */
 | {
    kind: "ladder";
    key: ClaimKey;
    record?: LadderRecord;
}
/** Writes the ladder's brake; absent clears it. */
 | {
    kind: "brake";
    brake?: BrakeState;
} | ReleaseAction | {
    kind: "spawn" | "retire" | "register";
};
/** The ledger after `actions`; a phase change restarts the phase clock, and so does a new agent. */
declare function applyActions(ledger: Ledger, actions: readonly LedgerAction[], now: Date): Ledger;

/** The code of highest precedence among `codes`, absent when there is none. */
declare const firstCode: (codes: readonly StallCode[]) => StallCode | undefined;
/** The exception class each stall code parks its claim under. */
declare const PARK_CLASS: Readonly<Record<StallCode, ExceptionClass>>;
/** The one shape of a park: the claim's stall patch with its class taken from the code. */
declare const parkUpdate: (key: ClaimKey, code: StallCode, detail: string) => Extract<LedgerAction, {
    kind: "update";
}>;

/** Named so a recorded failure says what failed without carrying a file path in the message. */
declare class LedgerMalformedError extends Error {
    name: string;
}
/**
 * Validates `text` as a `burndown.json` ledger and returns the raw parsed JSON, not zod's output: zod emits keys in
 * shape order and drops unknown ones, so only the raw value exports back to the same bytes. A malformed ledger throws,
 * because guessing would double-dispatch.
 */
declare function parseLedgerJson(text: string): Ledger;
/** The `burndown.json` bytes for `ledger`. */
declare const exportLedgerJson: (ledger: Ledger) => string;
/**
 * Write-then-rename in the same directory, so a reader never sees half a ledger. The export is read-only, so it
 * checks no phase edges; the store's write does.
 */
declare function writeLedgerExport(file: string, ledger: Ledger): void;

interface LedgerRead {
    ledger: Ledger;
    /** Bumped by every write; 0 before the first. */
    revision: number;
}
/** Where the ledger lives. A write checks the revision it read and the phase edges, and commits whole or not at all. */
interface LedgerStore {
    read(): LedgerRead;
    /** Throws `StaleRevisionError`, `IllegalPhaseEdgeError` or `LedgerMalformedError`, leaving the store unchanged. */
    write(next: Ledger, expectedRevision?: number): {
        revision: number;
    };
}
/** A write whose `expectedRevision` another writer has moved past; the caller re-reads and retries. */
declare class StaleRevisionError extends Error {
    name: string;
}
/**
 * zod's output, laid out in `raw`'s key order with keys zod added at the end: keys the schema does not name are
 * dropped and contract scopes trimmed as agent-chat's read does, while a ledger already in that form keeps its bytes.
 */
declare function normalizeLedger(raw: unknown): Ledger;
/** Validates `text` as `burndown.json` and writes it to `store`, normalized. */
declare function importLedgerJson(store: LedgerStore, text: string, expectedRevision?: number): {
    revision: number;
};
/** An in-process store for tests and dry runs; it hands out copies, so a caller's edits never reach it unwritten. */
declare function memoryLedgerStore(initial?: Ledger): LedgerStore;

/**
 * One row per claim, in ledger order, holding the claim's own JSON; the meta row holds the rest of the ledger with
 * `claims: []` in place, so the export keeps the file's key order.
 */
declare function dispatchLedgerDdl(): string;
declare function dispatchLedgerMigration(version: number): Migration;
/** The ledger on tables made by `dispatchLedgerDdl`; each write is one immediate transaction. */
declare class SqliteLedgerStore implements LedgerStore {
    private readonly db;
    constructor(db: Db);
    read(): LedgerRead;
    write(next: Ledger, expectedRevision?: number): {
        revision: number;
    };
    private readInside;
    private claims;
    private writeInside;
}

export { AGENT_PHASES, type AgentPhase, type BrakeState, CONTRACT_OPS, type Claim, type ClaimKey, type ClaimPatch, ClaimSchema, type Contract, type ContractOp, ContractSchema, DESTRUCTIVE_OPS, type DeciderState, EMPTY_LEDGER, EXCEPTION_CLASSES, type ExceptionClass, type IllegalEdge, IllegalPhaseEdgeError, LADDER_CODES, type LadderRecord, type Ledger, type LedgerAction, LedgerMalformedError, type LedgerRead, LedgerSchema, type LedgerStore, type LivenessRecord, PARK_CLASS, PHASES, PHASE_EDGES, PHASE_TIMEOUT_MS, type Phase, type ReleaseAction, type ReleaseRecord, SLOT_MISMATCH_TOLERANCE, STALE_CLASSES, STALL_CODES, type SeatState, SqliteLedgerStore, type StackPredicate, type StackedOn, type StaleClass, StaleRevisionError, type StallCode, type WakeRecord, addClaim, applyActions, claimKey, dispatchLedgerDdl, dispatchLedgerMigration, exportLedgerJson, firstCode, heldClaims, illegalEdgeError, illegalEdges, importLedgerJson, isStalled, laneClaims, ledgerImplementers, memoryLedgerStore, normalizeLedger, parkUpdate, parseLedgerJson, readySlices, sameClaim, slotMismatch, writeLedgerExport };
