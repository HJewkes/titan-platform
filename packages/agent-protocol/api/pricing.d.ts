import { UsageMeasurement } from '../index.js';
import { H as HarnessPriceCatalogRef, d as HarnessPricingPort } from '../pricing-port.js';
import '../source.js';

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
    /** Rates for every component, output included, once the prompt is strictly above `abovePromptTokens`. */
    longPrompt?: LongPromptPrice;
}
/** Prompt tokens are input + cache read + cache write, the sum session-graph stores as `context_tokens`. */
interface LongPromptPrice {
    abovePromptTokens: number;
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
}
/** Bump on any edit to PRICE_TABLE. The cost report prints it in its footer. */
declare const PRICE_TABLE_VERSION = 5;
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

/**
 * One dated rate row for a Codex model, in USD per million tokens. The package
 * ships no rows: pricing is product policy, and a checked-in table would go stale.
 */
interface CodexPriceRow {
    model: string;
    /** UTC date (YYYY-MM-DD) from which this row applies. */
    effectiveFrom: string;
    inputUsdPerMTok: number;
    cachedInputUsdPerMTok: number;
    outputUsdPerMTok: number;
}
declare function validateCodexPrices(prices: readonly CodexPriceRow[]): void;
/** Fills `cost` on measurements whose model has a row in force at `atMs`; others keep `cost: null`. */
declare function priceCodexUsage(measurements: readonly UsageMeasurement[], prices: readonly CodexPriceRow[], atMs: number): UsageMeasurement[];
interface CodexPricingPortOptions {
    readonly prices: readonly CodexPriceRow[];
    readonly catalog: Omit<HarnessPriceCatalogRef, "model" | "effectiveFrom">;
}
/** Pure caller-bound catalog. No bundled rates, catalog identity or native authority. */
declare function createCodexPricingPort(options: CodexPricingPortOptions): HarnessPricingPort<"codex">;

export { type CodexPriceRow, type CodexPricingPortOptions, type LongPromptPrice, PRICE_TABLE, PRICE_TABLE_VERSION, type PriceRow, type PricedRequest, type RequestTokens, createCodexPricingPort, findPrice, priceCodexUsage, priceRequest, validateCodexPrices };

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
