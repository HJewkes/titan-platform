/** `<prefix>.<name>`: a lowercase system prefix, then a name that may itself contain dots. */
declare const CORRELATION_KEY_PATTERN: RegExp;
/** Prefixes only their producer may write: `broker.*` for broker facts, `agent-thread.*` for thread links. */
declare const RESERVED_CORRELATION_PREFIXES: readonly ["broker", "agent-thread"];
declare const MAX_CORRELATIONS = 32;
declare const MAX_CORRELATION_VALUE_LENGTH = 512;
type ExecutionCorrelations = Readonly<Record<string, string>>;
declare function correlationKey(prefix: string, name: string): string;
/** Returns a frozen copy, so neither the caller nor a later transition can change what prepare stored. */
declare function validateCorrelations(correlations: unknown): ExecutionCorrelations;

declare const EXECUTION_PHASES: readonly ["prepared", "dispatching", "running", "cancel_requested", "recovery_required", "succeeded", "failed", "cancelled", "cancellation_unknown", "ended"];
type ExecutionPhase = (typeof EXECUTION_PHASES)[number];
declare const TERMINAL_EXECUTION_PHASES: readonly ["succeeded", "failed", "cancelled", "cancellation_unknown", "ended"];
type TerminalExecutionPhase = (typeof TERMINAL_EXECUTION_PHASES)[number];
interface ExecutionOwnerFence {
    supervisorId: string;
    generation: number;
}
interface ExecutionOwnerLease extends ExecutionOwnerFence {
    leaseUntil: string;
}
/** One agent generation succeeding another; the brief is a pointer and digest, never the text. */
interface HandoffIdentity {
    handoffId: string;
    /** The agentId of generation 1, constant across every handoff. */
    lineageId: string;
    generation: number;
    predecessor: {
        agent: AgentIdentity;
        executionId?: string;
        conversation?: ConversationIdentity;
    };
    brief: {
        ref: string;
        sha256: string;
        bytes: number;
    };
}
type LifecycleExecutionTarget = {
    kind: "fresh";
    namespace: string;
    pinnedNativeId?: string;
} | {
    kind: "resume";
    conversation: ConversationIdentity;
} | {
    kind: "fork";
    namespace: string;
    parent: ConversationIdentity;
} | {
    kind: "handoff";
    namespace: string;
    handoff: HandoffIdentity;
};
type ExecutionTerminal<TResult = unknown> = {
    outcome: "succeeded";
    result: TResult;
}
/** usage is what the harness reported spending before it failed, so budgets can count it. */
 | {
    outcome: "failed";
    reason: string;
    retryable: boolean;
    usage?: readonly UsageMeasurement[];
} | {
    outcome: "cancelled";
    reason: string;
}
/** usage is what the harness reported spending before it was stopped, so budgets can count it. */
 | {
    outcome: "cancellation_unknown";
    reason: string;
    evidence: string;
    usage?: readonly UsageMeasurement[];
}
/** The process was observed gone without a harness result, so success cannot be claimed. */
 | {
    outcome: "ended";
    evidence: string;
    exit?: {
        code: number | null;
        signal: string | null;
    };
};
interface ExecutionRecord<TResult = unknown> {
    execution: ExecutionIdentity;
    agent?: AgentIdentity;
    harness: string;
    requestKey: string;
    target: LifecycleExecutionTarget;
    phase: ExecutionPhase;
    revision: number;
    ownerGeneration: number;
    owner?: ExecutionOwnerLease;
    runnerRef?: string;
    /** Adapter-assigned invocation identity, distinct from the caller's durable execution ID. */
    adapterExecution?: ExecutionIdentity;
    surface?: SurfaceIdentity;
    preparedAt: string;
    dispatchedAt?: string;
    cancellation?: {
        requestedAt: string;
        reason: string;
    };
    recovery?: {
        requiredAt: string;
        evidence: string;
    };
    finishedAt?: string;
    lastObservedAt: string;
    terminal?: ExecutionTerminal<TResult>;
    /** Namespaced `<prefix>.<name>` keys set once by prepare; see CORRELATION_KEY_PATTERN. */
    correlations?: ExecutionCorrelations;
}
interface ExecutionTransitionBase {
    executionId: string;
    eventId: string;
    expectedRevision: number;
    occurredAt: string;
}
type ExecutionTransition<TResult = unknown> = (ExecutionTransitionBase & {
    kind: "prepare";
    expectedRevision: 0;
    execution: ExecutionIdentity;
    agent?: AgentIdentity;
    harness: string;
    requestKey: string;
    target: LifecycleExecutionTarget;
    owner: ExecutionOwnerLease;
    correlations?: ExecutionCorrelations;
}) | (ExecutionTransitionBase & {
    kind: "begin_dispatch";
    fence: ExecutionOwnerFence;
}) | (ExecutionTransitionBase & {
    kind: "observe_running";
    fence: ExecutionOwnerFence;
    runnerRef: string;
    adapterExecution: ExecutionIdentity;
    conversation?: ConversationIdentity;
    surface?: SurfaceIdentity;
    evidence: string;
}) | (ExecutionTransitionBase & {
    kind: "observe_launched";
    fence: ExecutionOwnerFence;
    runnerRef: string;
    surface: SurfaceIdentity;
    evidence: string;
}) | (ExecutionTransitionBase & {
    kind: "identify_conversation";
    fence: ExecutionOwnerFence;
    conversation: ConversationIdentity;
}) | (ExecutionTransitionBase & {
    kind: "request_cancellation";
    fence: ExecutionOwnerFence;
    reason: string;
}) | (ExecutionTransitionBase & {
    kind: "require_recovery";
    fence: ExecutionOwnerFence;
    evidence: string;
}) | (ExecutionTransitionBase & {
    kind: "finish";
    fence: ExecutionOwnerFence;
    terminal: ExecutionTerminal<TResult>;
    adapterExecution?: ExecutionIdentity;
    conversation?: ConversationIdentity;
}) | (ExecutionTransitionBase & {
    kind: "claim_owner";
    owner: ExecutionOwnerLease;
}) | (ExecutionTransitionBase & {
    kind: "renew_owner";
    fence: ExecutionOwnerFence;
    leaseUntil: string;
}) | (ExecutionTransitionBase & {
    kind: "release_owner";
    fence: ExecutionOwnerFence;
});
type ExecutionReconcileOutcome<TResult, TRunning> = {
    kind: "running";
    running: TRunning;
    evidence: string;
} | {
    kind: "terminal";
    terminal: ExecutionTerminal<TResult>;
    evidence: string;
} | {
    kind: "not_found";
    retrySafe: boolean;
    evidence: string;
} | {
    kind: "ownership_lost";
    evidence: string;
} | {
    kind: "unknown";
    evidence: string;
};

/**
 * `execution` fences each row by its own owner lease. `supervisor` fences by one supervisor-wide lease
 * that the ledger reads inside its atomic operation, so a restarted supervisor adopts rows without per-row events.
 */
type ExecutionFencing = {
    kind: "execution";
} | {
    kind: "supervisor";
    lease: ExecutionOwnerLease;
};
interface ExecutionReducerOptions {
    fencing?: ExecutionFencing;
}

type ExecutionTransitionErrorCode = "not_found" | "revision_conflict" | "invalid_transition" | "ownership_lost";
declare class ExecutionTransitionError extends Error {
    readonly code: ExecutionTransitionErrorCode;
    constructor(code: ExecutionTransitionErrorCode, message: string);
}

declare function isTerminalExecutionPhase(phase: ExecutionPhase): phase is TerminalExecutionPhase;
/** The default fencing mode is the per-execution owner lease. */
declare function reduceExecutionTransition<TResult>(current: ExecutionRecord<TResult> | undefined, transition: ExecutionTransition<TResult>, options?: ExecutionReducerOptions): ExecutionRecord<TResult>;

/** The measurements that describe distinct spend, and which kind they are. */
interface UsageFold {
    basis: "delta" | "snapshot";
    measurements: UsageMeasurement[];
}
/** Picks non-overlapping measurements: deltas win over snapshots, which describe the same spend. */
declare function foldUsage(measurements: Iterable<UsageMeasurement>): UsageFold;

/** Native conversation identity. Namespace identifies a host/account corpus, not a path. */
interface ConversationIdentity {
    harness: string;
    namespace: string;
    nativeId: string;
}
/** Durable orchestration identity, independent of any one native conversation. */
interface AgentIdentity {
    agentId: string;
}
/** One invocation; its native conversation may become known only after launch. */
interface ExecutionIdentity {
    executionId: string;
    conversation?: ConversationIdentity;
}
/** Ownership is teardown authority, not evidence that the process is still alive. */
interface SurfaceIdentity {
    kind: string;
    host: string;
    nativeId: string;
    owned: boolean;
}

/** Stable, collision-free key. Legacy session refs remain a separate alias vocabulary. */
declare function conversationRef(identity: ConversationIdentity): string;
/** Call, turn and item IDs are unique within their conversation and category only. */
declare function conversationItemRef(identity: ConversationIdentity, kind: "turn" | "call" | "item" | "response", nativeId: string): string;
/** Null means unreported. Input includes cache reads/writes; output includes reasoning. */
interface TokenCounts {
    input: number | null;
    output: number | null;
    cachedInput: number | null;
    cacheWriteInput: number | null;
    reasoningOutput: number | null;
    total: number | null;
}
/** Delta IDs deduplicate responses; snapshots replace by source order within a reset epoch. */
type UsageMeasurement = {
    model: string | null;
    tokens: TokenCounts;
    cost: {
        usd: number;
        kind: "estimate" | "reported";
    } | null;
    source: string;
} & ({
    kind: "delta";
    responseId: string;
} | {
    kind: "snapshot";
    scope: "turn" | "conversation";
    scopeId: string;
    epoch: string;
    sequence: number;
});

export { type AgentIdentity, CORRELATION_KEY_PATTERN, type ConversationIdentity, EXECUTION_PHASES, type ExecutionCorrelations, type ExecutionFencing, type ExecutionIdentity, type ExecutionOwnerFence, type ExecutionOwnerLease, type ExecutionPhase, type ExecutionReconcileOutcome, type ExecutionRecord, type ExecutionReducerOptions, type ExecutionTerminal, type ExecutionTransition, ExecutionTransitionError, type ExecutionTransitionErrorCode, type HandoffIdentity, type LifecycleExecutionTarget, MAX_CORRELATIONS, MAX_CORRELATION_VALUE_LENGTH, RESERVED_CORRELATION_PREFIXES, type SurfaceIdentity, TERMINAL_EXECUTION_PHASES, type TerminalExecutionPhase, type TokenCounts, type UsageFold, type UsageMeasurement, conversationItemRef, conversationRef, correlationKey, foldUsage, isTerminalExecutionPhase, reduceExecutionTransition, validateCorrelations };
