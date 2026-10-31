import { ConversationIdentity, ExecutionIdentity, UsageMeasurement } from '../index.js';
import { S as SessionSourceDescriptor, R as ReadSessionObservationOptions, a as SessionObservationReadResult, N as NormalizedSessionObservation, b as SourceTextLocator, c as ReadSessionSourceTextOptions } from '../source.js';
export { C as CacheWriteSplit, d as ConversationItemKind, D as DecodeRequest, e as DecodeResult, f as DecodeResume, g as DecoderCheckpoint, E as EmitNormalizedObservation, L as LocatedSourceLine, h as NormalizedCompactionObservation, i as NormalizedLineageObservation, j as NormalizedMessageObservation, k as NormalizedMetadataObservation, l as NormalizedNativeExtension, m as NormalizedNativeTurnObservation, n as NormalizedObservationBase, o as NormalizedObservationKind, p as NormalizedObservationOf, q as NormalizedTextPart, r as NormalizedToolCallObservation, s as NormalizedToolResultObservation, t as NormalizedUnknownObservation, u as NormalizedUsageObservation, O as ObservationIdentity, v as ResumeBoundary, w as ScopedConversationItemId, x as SessionFormatDecoder, y as SessionSourceProvenance, z as SourceEvidence, A as SourceLineEvidence, B as SourceSubrecordEvidence } from '../source.js';
export { H as HarnessPriceCatalogRef, a as HarnessPricePolicyRef, b as HarnessPriceQuote, c as HarnessPricingContext, d as HarnessPricingPort } from '../pricing-port.js';

/** Corpus/account roots are bound by the adapter; cwd is only an optional lookup hint. */
interface HarnessSourceQuery {
    conversation: ConversationIdentity;
    cwd?: string;
}
/** not_written retains an expected location; absent or unreadable evidence is unavailable. */
type HarnessSourceLookup = {
    status: "found";
    sources: readonly [SessionSourceDescriptor, ...SessionSourceDescriptor[]];
} | {
    status: "not_written";
    expectedPaths: readonly [string, ...string[]];
} | {
    status: "unavailable";
    reason: string;
};
interface HarnessSourceCapabilities {
    discover: CapabilityAssessment;
    locate: CapabilityAssessment;
    observations: CapabilityAssessment;
    text: CapabilityAssessment;
    /** Assessment only; this port neither classifies finality nor proves a process finished. */
    semanticFinality: CapabilityAssessment;
}
/** Required unsupported/unverified operations must be refused before invocation. */
interface HarnessSourcePort {
    readonly capabilities: HarnessSourceCapabilities;
    discover(): Promise<readonly SessionSourceDescriptor[]>;
    locate(query: HarnessSourceQuery): Promise<HarnessSourceLookup>;
    readObservations(source: SessionSourceDescriptor, options?: ReadSessionObservationOptions, onDone?: (result: SessionObservationReadResult) => void): AsyncIterable<NormalizedSessionObservation>;
    readText(locator: SourceTextLocator, options?: ReadSessionSourceTextOptions): Promise<string | null>;
}

/** Interface compatibility, independent of an adapter binary's own version. */
declare const HARNESS_CONTRACT_VERSION: 1;
/** Opaque references; producers keep native homes and credentials outside this contract. */
interface HarnessAccountRef<H extends string = string> {
    readonly harness: H;
    readonly host: string;
    readonly accountId: string;
    readonly billingPoolId: string;
}
/** Intent resolved inside the selected adapter; consumers do not infer a provider from it. */
interface HarnessModelIntent {
    readonly model?: string;
    readonly reasoningEffort?: string;
}
/** Persist the selected binding for resume; changing fallback creates a new execution. */
interface HarnessExecutionBinding<H extends string = string> {
    readonly profileRef: string;
    readonly account: HarnessAccountRef<H>;
    readonly model?: HarnessModelIntent;
    readonly policyRevision: string;
}
type HarnessOutputIntent<T = string> = {
    readonly kind: "text";
} | {
    readonly kind: "structured";
    readonly jsonSchema: Readonly<Record<string, unknown>>;
    /** Adapter validates output again after any native schema constraint. */
    readonly parse: (value: unknown) => T;
};
/** Metadata and output intent only; native SDK options remain private to adapter modules. */
interface HarnessExecutionRequest<H extends string = string, T = string> extends BoundedRunBase<H> {
    readonly harness: H;
    readonly binding: HarnessExecutionBinding<H>;
    readonly output?: HarnessOutputIntent<T>;
}
/** In-process port; a conforming implementation still needs independently qualified runtime evidence. */
interface HarnessExecutionPort<H extends string = string> {
    readonly contractVersion: typeof HARNESS_CONTRACT_VERSION;
    readonly descriptor: HarnessCapabilityDescriptor<H>;
    run<T = string>(request: HarnessExecutionRequest<H, T>): Promise<HarnessRunResult<T, H>>;
}
/** A transport acknowledgment is not a terminal result or an authenticated authority grant. */
type HarnessDispatchReceipt<H extends string = string> = {
    readonly state: "accepted";
    readonly harness: H;
    readonly execution: ExecutionIdentity;
    readonly binding: HarnessExecutionBinding<H>;
} | {
    readonly state: "running";
    readonly harness: H;
    readonly execution: ExecutionIdentity;
    readonly binding: HarnessExecutionBinding<H>;
    readonly observedAtMs: number;
    readonly conversation?: ConversationIdentity;
} | {
    readonly state: "refused";
    readonly harness: H;
    readonly failure: HarnessRunFailure;
};

declare const EXECUTION_CAPABILITIES: readonly ["fresh_run", "resume", "fork", "structured_output", "interactive_approvals", "external_cancellation", "semantic_interrupt", "active_turn_steering", "idle_turn_submission", "persisted_transcript", "process_reattachment", "token_reporting"];
type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];
type CapabilityAssessment = {
    status: "supported";
    evidence: string;
} | {
    status: "unsupported" | "unverified";
    reason: string;
};
type LimitUnit = "milliseconds" | "usd" | "model_requests" | "agent_iterations" | "tokens";
type OptionalLimitUnit = Exclude<LimitUnit, "milliseconds">;
type LimitScope = "execution" | "conversation";
type LimitEnforcement = "hard" | "advisory";
interface ExecutionLimit {
    unit: OptionalLimitUnit;
    value: number;
    scope: LimitScope;
    enforcement: LimitEnforcement;
}
interface LimitCapability {
    unit: LimitUnit;
    scope: LimitScope;
    enforcement: LimitEnforcement;
    assessment: CapabilityAssessment;
}
/** A factual report supplied by an adapter implementation, not a promise made by the core. */
interface HarnessCapabilityDescriptor<H extends string = string> {
    harness: H;
    adapter: {
        name: string;
        version: string;
    };
    capabilities: Record<ExecutionCapability, CapabilityAssessment>;
    limits: readonly LimitCapability[];
}
type RunTarget = {
    kind: "fresh";
    namespace: string;
} | {
    kind: "resume";
    conversation: ConversationIdentity;
};
interface BoundedRunBase<H extends string = string> {
    prompt: string;
    cwd: string;
    target: RunTarget;
    /** Required hard deadline for this execution. Must be positive and finite. */
    wallTimeMs: number;
    limits?: readonly ExecutionLimit[];
    requires?: readonly ExecutionCapability[];
    signal?: AbortSignal;
    onProgress?: (progress: HarnessRunProgress<H>) => void;
}
type HarnessRunProgress<H extends string = string> = {
    harness: H;
    atMs: number;
} & ({
    kind: "execution_started";
    execution: ExecutionIdentity;
} | {
    kind: "conversation_identified";
    executionId: string;
    conversation: ConversationIdentity;
} | {
    kind: "assistant_output";
    executionId: string;
    text: string;
} | {
    kind: "usage";
    executionId: string;
    measurement: UsageMeasurement;
} | {
    kind: "execution_finished";
    executionId: string;
    outcome: "succeeded" | "failed" | "cancelled";
});
type HarnessRunOutput<T> = {
    kind: "text";
    text: string;
} | {
    kind: "structured";
    value: T;
};
interface TranscriptSourceHint {
    format: string;
    namespace: string;
    path?: string;
}
/**
 * Why a harness run did not succeed. Durable dispatch treats only `runtime_error` as
 * ambiguous: the transport was lost and the native run may still be live, so the record
 * parks in `recovery_required`. `aborted`, `cancelled_unknown` and `wall_time_exceeded`
 * end as `cancellation_unknown`. Every other kind is definite and ends as `failed`,
 * including `limit_exceeded` for a native cap such as maxTurns and `harness_mismatch`
 * for an installed runtime rejected before spawn.
 */
type HarnessRunFailure = {
    kind: "invalid_request";
    reason: string;
} | {
    kind: "harness_mismatch";
    reason: string;
} | {
    kind: "unsupported_requirement";
    reason: string;
    requirement: {
        kind: "capability";
        capability: ExecutionCapability;
    } | {
        kind: "limit";
        limit: LimitCapability;
    };
    status: "unsupported" | "unverified";
} | {
    kind: "rate_limited";
    reason: string;
    retryAtMs?: number;
    native?: unknown;
} | {
    kind: "limit_exceeded";
    reason: string;
    unit: LimitUnit;
    native?: unknown;
} | {
    kind: "output_invalid";
    reason: string;
    native?: unknown;
} | {
    kind: "auth_misconfigured";
    reason: string;
    native?: unknown;
} | {
    kind: "aborted";
    reason: string;
} | {
    kind: "wall_time_exceeded";
    reason: string;
    wallTimeMs: number;
} | {
    kind: "cancelled_unknown";
    reason: string;
    native?: unknown;
} | {
    kind: "runtime_error";
    reason: string;
    native?: unknown;
};
type HarnessRunResult<T = string, H extends string = string> = {
    ok: true;
    harness: H;
    execution: ExecutionIdentity;
    conversation: ConversationIdentity;
    output: HarnessRunOutput<T>;
    usage: readonly UsageMeasurement[];
    transcript?: TranscriptSourceHint;
} | {
    ok: false;
    harness: H;
    execution?: ExecutionIdentity;
    conversation?: ConversationIdentity;
    failure: HarnessRunFailure;
    usage: readonly UsageMeasurement[];
};

export { type BoundedRunBase, type CapabilityAssessment, EXECUTION_CAPABILITIES, type ExecutionCapability, type ExecutionLimit, HARNESS_CONTRACT_VERSION, type HarnessAccountRef, type HarnessCapabilityDescriptor, type HarnessDispatchReceipt, type HarnessExecutionBinding, type HarnessExecutionPort, type HarnessExecutionRequest, type HarnessModelIntent, type HarnessOutputIntent, type HarnessRunFailure, type HarnessRunOutput, type HarnessRunProgress, type HarnessRunResult, type HarnessSourceCapabilities, type HarnessSourceLookup, type HarnessSourcePort, type HarnessSourceQuery, type LimitCapability, type LimitEnforcement, type LimitScope, type LimitUnit, NormalizedSessionObservation, type OptionalLimitUnit, ReadSessionObservationOptions, ReadSessionSourceTextOptions, type RunTarget, SessionObservationReadResult, SessionSourceDescriptor, SourceTextLocator, type TranscriptSourceHint };

// ./dist/pricing-port.d.ts
import { UsageMeasurement } from './index.js';
import { C as CacheWriteSplit } from './source.js';

/** Versioned policy metadata, never executable code supplied by a profile. */
interface HarnessPricePolicyRef {
    readonly id: string;
    readonly version: string;
}
/** Evidence for the dated catalog row and accounting rules selected by an adapter. */
interface HarnessPriceCatalogRef {
    readonly id: string;
    readonly version: string;
    readonly provider: string;
    readonly model: string;
    readonly effectiveFrom: string;
    readonly matchingPolicy: HarnessPricePolicyRef;
    readonly accountingPolicy: HarnessPricePolicyRef;
}
/** Evidence paired with the same normalized usage observation; no native fields are required. */
interface HarnessPricingContext {
    readonly cacheWriteSplit?: Readonly<CacheWriteSplit>;
}
/** Unpriced is explicit; a reported zero remains distinct from an unavailable price. */
type HarnessPriceQuote = {
    readonly status: "priced";
    readonly cost: NonNullable<UsageMeasurement["cost"]> & {
        readonly kind: "reported";
    };
    readonly basis: {
        readonly kind: "reported";
        readonly source: string;
    };
} | {
    readonly status: "priced";
    readonly cost: NonNullable<UsageMeasurement["cost"]> & {
        readonly kind: "estimate";
    };
    /** The current normalized record source, without reconstructing its original catalog. */
    readonly basis: {
        readonly kind: "existing_estimate";
        readonly source: string;
    };
} | {
    readonly status: "priced";
    readonly cost: NonNullable<UsageMeasurement["cost"]> & {
        readonly kind: "estimate";
    };
    readonly basis: {
        readonly kind: "catalog";
        readonly atMs: number;
        readonly catalog: HarnessPriceCatalogRef;
    };
} | {
    readonly status: "unpriced";
    readonly reason: string;
};
/** Pure, bound quote service; implementations own matching and accounting, not consumers. */
interface HarnessPricingPort<H extends string = string> {
    readonly harness: H;
    /** atMs is event time in epoch milliseconds. This port neither sums usage nor mutates it. */
    quote(measurement: UsageMeasurement, atMs: number, context?: HarnessPricingContext): HarnessPriceQuote;
}

export type { HarnessPriceCatalogRef as H, HarnessPricePolicyRef as a, HarnessPriceQuote as b, HarnessPricingContext as c, HarnessPricingPort as d };

// ./dist/source.d.ts
import { ConversationIdentity, UsageMeasurement } from './index.js';

/**
 * One physical transcript source. A conversation may have more than one source.
 * Discovery must keep harness and namespace equal to the conversation identity;
 * decoders must reject inconsistent descriptors before emitting observations.
 */
interface SessionSourceDescriptor {
    /** Stable within the source namespace; paths may move between discovery passes. */
    sourceId: string;
    harness: string;
    format: string;
    formatVersion: string | null;
    path: string;
    namespace: string;
    conversation: ConversationIdentity;
    provenance: SessionSourceProvenance;
}
/** Provenance is explicit so compatibility aliases never depend on a namespace convention. */
type SessionSourceProvenance = {
    kind: "claude-code-transcript";
    legacySessionId: string;
} | {
    kind: "codex-rollout";
    sessionTreeId: string | null;
    historyMode: "legacy" | "paginated" | "unknown";
} | {
    kind: "native";
    name: string;
    details?: Readonly<Record<string, unknown>>;
};
/** The complete source line that carried one or more semantic subrecords. */
interface SourceLineEvidence {
    sourceId: string;
    byteOffset: number;
    byteLength: number;
    /** SHA-256 of the exact line bytes, excluding its newline. */
    contentHash: string;
    lineNumber: number | null;
    nativeOrdinal: number | null;
}
/** A decoder-stable location within a source line. */
interface SourceSubrecordEvidence {
    /** Distinguishes semantic siblings emitted from the same source line. */
    index: number;
    /** Format-native location, such as a JSON path. */
    path: readonly (string | number)[];
}
interface SourceEvidence {
    line: SourceLineEvidence;
    subrecord: SourceSubrecordEvidence;
}
/** Stable semantic identity without claiming that a native item ID is globally unique. */
interface ObservationIdentity {
    sourceId: string;
    byteOffset: number;
    subrecordIndex: number;
}
type ConversationItemKind = "turn" | "call" | "item" | "response";
/** A native identifier qualified by its conversation and category. */
interface ScopedConversationItemId<K extends ConversationItemKind = ConversationItemKind> {
    conversation: ConversationIdentity;
    kind: K;
    nativeId: string;
}
/** Selects decoded text within a record. There is deliberately no whole-line selector. */
interface SourceTextLocator {
    /** Discovery snapshot; resolve sourceId to the current path when sources move. */
    source: SessionSourceDescriptor;
    evidence: SourceEvidence;
    selector: {
        kind: "subrecord-text";
        path: readonly (string | number)[];
        textIndex?: number;
    };
}
interface NormalizedTextPart {
    kind: "text";
    text: string;
    locator: SourceTextLocator;
}
/** Native source fields retained without assigning portable semantics. */
interface NormalizedNativeExtension {
    name: string;
    value: unknown;
}
interface NormalizedObservationBase {
    nativeExtensions?: readonly NormalizedNativeExtension[];
    id: ObservationIdentity;
    /** Conversation represented by the physical source. */
    conversation: ConversationIdentity;
    /** Active native turn when the source format provides one. */
    turn?: ScopedConversationItemId<"turn"> | null;
    /** Set when copied history originated in a different conversation. */
    historyOrigin: ConversationIdentity | null;
    timestamp: string | null;
    evidence: SourceEvidence;
}
interface NormalizedMessageObservation extends NormalizedObservationBase {
    kind: "message";
    role: "user" | "assistant";
    item: ScopedConversationItemId<"item"> | null;
    representation: "canonical" | "projection-fallback";
    content: readonly NormalizedTextPart[];
}
interface NormalizedToolCallObservation extends NormalizedObservationBase {
    kind: "tool_call";
    call: ScopedConversationItemId<"call">;
    item: ScopedConversationItemId<"item"> | null;
    name: string;
    namespace: string | null;
    input: unknown;
    inputLocator: SourceTextLocator | null;
}
interface NormalizedToolResultObservation extends NormalizedObservationBase {
    kind: "tool_result";
    call: ScopedConversationItemId<"call">;
    item: ScopedConversationItemId<"item"> | null;
    output: unknown;
    outputLocator: SourceTextLocator | null;
    isError: boolean | null;
}
interface NormalizedNativeTurnObservation extends NormalizedObservationBase {
    kind: "native_turn";
    turn: ScopedConversationItemId<"turn">;
    rootTurn: ScopedConversationItemId<"turn"> | null;
    phase: "started" | "completed" | "aborted" | "observed";
}
/** Native-valued entries preserve metadata that does not yet have shared semantics. */
interface NormalizedMetadataObservation extends NormalizedObservationBase {
    kind: "metadata";
    scope: "source" | "conversation" | "turn";
    turn: ScopedConversationItemId<"turn"> | null;
    entries: readonly {
        name: string;
        value: unknown;
        meaning: "normalized" | "native";
    }[];
}
type DeltaUsage = Extract<UsageMeasurement, {
    kind: "delta";
}>;
type SnapshotUsage = Extract<UsageMeasurement, {
    kind: "snapshot";
}>;
/** Cache writes by time to live; the two rates differ, so a price needs the split, not the total. */
interface CacheWriteSplit {
    ttl5m: number;
    ttl1h: number;
}
type NormalizedUsageObservation = NormalizedObservationBase & ({
    kind: "usage";
    measurement: DeltaUsage;
    response: ScopedConversationItemId<"response">;
    turn: ScopedConversationItemId<"turn"> | null;
    /** Absent when the source reports only the cache-write total. */
    cacheWriteSplit?: CacheWriteSplit;
} | {
    kind: "usage";
    measurement: SnapshotUsage;
    response: null;
    turn: ScopedConversationItemId<"turn"> | null;
});
interface NormalizedCompactionObservation extends NormalizedObservationBase {
    kind: "compaction";
    turn: ScopedConversationItemId<"turn"> | null;
    item: ScopedConversationItemId<"item"> | null;
    encrypted: boolean | null;
    usageEpochAfter: string | null;
}
interface NormalizedLineageObservation extends NormalizedObservationBase {
    kind: "lineage";
    relationship: "parent" | "forked_from";
    relatedConversation: ConversationIdentity;
    copiedThroughTurn: ScopedConversationItemId<"turn"> | null;
}
interface NormalizedUnknownObservation extends NormalizedObservationBase {
    kind: "unknown";
    nativeKind: string;
    value: unknown;
}
type NormalizedSessionObservation = NormalizedMessageObservation | NormalizedToolCallObservation | NormalizedToolResultObservation | NormalizedNativeTurnObservation | NormalizedMetadataObservation | NormalizedUsageObservation | NormalizedCompactionObservation | NormalizedLineageObservation | NormalizedUnknownObservation;
type NormalizedObservationKind = NormalizedSessionObservation["kind"];
type NormalizedObservationOf<K extends NormalizedObservationKind> = Extract<NormalizedSessionObservation, {
    kind: K;
}>;
/** A complete newline-terminated record. Partial final lines are retried by the caller. */
interface LocatedSourceLine {
    raw: string;
    evidence: SourceLineEvidence;
}
/** Boundary immediately after a complete line, bound to the exact preceding bytes. */
interface ResumeBoundary {
    byteOffset: number;
    prefixHash: string;
}
interface DecoderCheckpoint<State> {
    decoderId: string;
    checkpointVersion: string;
    sourceId: string;
    boundary: ResumeBoundary;
    state: State;
}
/**
 * Lines begin at `readFromByteOffset`; observations before `emitFrom` are suppressed.
 * A decoder may therefore replay a prefix for state, or continue from a validated
 * checkpoint. Callers fall back to replay when any checkpoint identity or hash differs.
 */
type DecodeResume<State> = {
    strategy: "replay-prefix";
    readFromByteOffset: 0;
    emitFrom: ResumeBoundary;
    checkpoint: null;
} | {
    strategy: "checkpoint";
    readFromByteOffset: number;
    emitFrom: ResumeBoundary;
    checkpoint: DecoderCheckpoint<State>;
};
interface DecodeRequest<State> {
    source: SessionSourceDescriptor;
    lines: AsyncIterable<LocatedSourceLine>;
    resume: DecodeResume<State>;
}
interface DecodeResult<State> {
    resumeBoundary: ResumeBoundary;
    checkpoint: DecoderCheckpoint<State> | null;
}
type EmitNormalizedObservation = (observation: NormalizedSessionObservation) => void;
/** Format adapter contract; implementations arrive with their respective decoders. */
interface SessionFormatDecoder<State = unknown> {
    readonly decoderId: string;
    readonly checkpointVersion: string;
    decode(request: DecodeRequest<State>, emit: EmitNormalizedObservation): Promise<DecodeResult<State>>;
    /**
     * Returns only selected semantic text, never the complete JSON record. Resolve
     * moved sources by sourceId; return null if unavailable rather than reading an
     * unrelated file now occupying the snapshot path.
     */
    readText(locator: SourceTextLocator): Promise<string | null>;
}
interface ReadSessionObservationOptions {
    from?: ResumeBoundary;
    /** Test seam for ending after a complete line in a growing source. */
    untilByteOffset?: number;
}
interface SessionObservationReadResult {
    startByteOffset: number;
    resumeBoundary: ResumeBoundary;
    restartedFromZero: boolean;
}
interface ReadSessionSourceTextOptions {
    /** Fresh discovery results used to resolve a source whose path moved. */
    sources?: readonly SessionSourceDescriptor[];
}

export type { SourceLineEvidence as A, SourceSubrecordEvidence as B, CacheWriteSplit as C, DecodeRequest as D, EmitNormalizedObservation as E, LocatedSourceLine as L, NormalizedSessionObservation as N, ObservationIdentity as O, ReadSessionObservationOptions as R, SessionSourceDescriptor as S, SessionObservationReadResult as a, SourceTextLocator as b, ReadSessionSourceTextOptions as c, ConversationItemKind as d, DecodeResult as e, DecodeResume as f, DecoderCheckpoint as g, NormalizedCompactionObservation as h, NormalizedLineageObservation as i, NormalizedMessageObservation as j, NormalizedMetadataObservation as k, NormalizedNativeExtension as l, NormalizedNativeTurnObservation as m, NormalizedObservationBase as n, NormalizedObservationKind as o, NormalizedObservationOf as p, NormalizedTextPart as q, NormalizedToolCallObservation as r, NormalizedToolResultObservation as s, NormalizedUnknownObservation as t, NormalizedUsageObservation as u, ResumeBoundary as v, ScopedConversationItemId as w, SessionFormatDecoder as x, SessionSourceProvenance as y, SourceEvidence as z };
