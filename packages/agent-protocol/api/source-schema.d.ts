import { z } from 'zod';
import { UsageMeasurement } from './index.js';
import { S as SessionSourceDescriptor, b as SourceTextLocator } from './source.js';

/** Reads a stored source descriptor. */
declare const SessionSourceDescriptorSchema: z.ZodType<SessionSourceDescriptor>;
/** Reads a stored text locator. */
declare const SourceTextLocatorSchema: z.ZodType<SourceTextLocator>;
/**
 * Reads a stored usage measurement. Unlike the trace subpath's producer schema, unknown keys
 * pass and values are not range-checked, so a reader never drops a row a writer accepted.
 */
declare const UsageMeasurementSchema: z.ZodType<UsageMeasurement>;

export { SessionSourceDescriptorSchema, SourceTextLocatorSchema, UsageMeasurementSchema };

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
