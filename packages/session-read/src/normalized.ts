import type { ConversationIdentity, UsageMeasurement } from "@titan-design/agent-protocol";
import { conversationItemRef } from "@titan-design/agent-protocol";
import { sessionRef } from "./refs.js";

/**
 * One physical transcript source. A conversation may have more than one source.
 * Discovery must keep harness and namespace equal to the conversation identity;
 * decoders must reject inconsistent descriptors before emitting observations.
 */
export interface SessionSourceDescriptor {
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
export type SessionSourceProvenance =
  | { kind: "claude-code-transcript"; legacySessionId: string }
  | { kind: "codex-rollout"; sessionTreeId: string | null; historyMode: "legacy" | "paginated" | "unknown" }
  | { kind: "native"; name: string; details?: Readonly<Record<string, unknown>> };

/** The complete source line that carried one or more semantic subrecords. */
export interface SourceLineEvidence {
  sourceId: string;
  byteOffset: number;
  byteLength: number;
  /** SHA-256 of the exact line bytes, excluding its newline. */
  contentHash: string;
  lineNumber: number | null;
  nativeOrdinal: number | null;
}

/** A decoder-stable location within a source line. */
export interface SourceSubrecordEvidence {
  /** Distinguishes semantic siblings emitted from the same source line. */
  index: number;
  /** Format-native location, such as a JSON path. */
  path: readonly (string | number)[];
}

export interface SourceEvidence {
  line: SourceLineEvidence;
  subrecord: SourceSubrecordEvidence;
}

/** Stable semantic identity without claiming that a native item ID is globally unique. */
export interface ObservationIdentity {
  sourceId: string;
  byteOffset: number;
  subrecordIndex: number;
}

export type ConversationItemKind = "turn" | "call" | "item" | "response";

/** A native identifier qualified by its conversation and category. */
export interface ScopedConversationItemId<K extends ConversationItemKind = ConversationItemKind> {
  conversation: ConversationIdentity;
  kind: K;
  nativeId: string;
}

export function scopedConversationItemRef(item: ScopedConversationItemId): string {
  return conversationItemRef(item.conversation, item.kind, item.nativeId);
}

/** Selects decoded text within a record. There is deliberately no whole-line selector. */
export interface SourceTextLocator {
  /** Discovery snapshot; resolve sourceId to the current path when sources move. */
  source: SessionSourceDescriptor;
  evidence: SourceEvidence;
  selector: {
    kind: "subrecord-text";
    path: readonly (string | number)[];
    textIndex?: number;
  };
}

export interface NormalizedTextPart {
  kind: "text";
  text: string;
  locator: SourceTextLocator;
}

export interface NormalizedObservationBase {
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

export interface NormalizedMessageObservation extends NormalizedObservationBase {
  kind: "message";
  role: "user" | "assistant";
  item: ScopedConversationItemId<"item"> | null;
  representation: "canonical" | "projection-fallback";
  content: readonly NormalizedTextPart[];
}

export interface NormalizedToolCallObservation extends NormalizedObservationBase {
  kind: "tool_call";
  call: ScopedConversationItemId<"call">;
  item: ScopedConversationItemId<"item"> | null;
  name: string;
  namespace: string | null;
  input: unknown;
  inputLocator: SourceTextLocator | null;
}

export interface NormalizedToolResultObservation extends NormalizedObservationBase {
  kind: "tool_result";
  call: ScopedConversationItemId<"call">;
  item: ScopedConversationItemId<"item"> | null;
  output: unknown;
  outputLocator: SourceTextLocator | null;
  isError: boolean | null;
}

export interface NormalizedNativeTurnObservation extends NormalizedObservationBase {
  kind: "native_turn";
  turn: ScopedConversationItemId<"turn">;
  rootTurn: ScopedConversationItemId<"turn"> | null;
  phase: "started" | "completed" | "aborted" | "observed";
}

/** Native-valued entries preserve metadata that does not yet have shared semantics. */
export interface NormalizedMetadataObservation extends NormalizedObservationBase {
  kind: "metadata";
  scope: "source" | "conversation" | "turn";
  turn: ScopedConversationItemId<"turn"> | null;
  entries: readonly {
    name: string;
    value: unknown;
    meaning: "normalized" | "native";
  }[];
}

type DeltaUsage = Extract<UsageMeasurement, { kind: "delta" }>;
type SnapshotUsage = Extract<UsageMeasurement, { kind: "snapshot" }>;

export type NormalizedUsageObservation = NormalizedObservationBase &
  (
    | {
        kind: "usage";
        measurement: DeltaUsage;
        response: ScopedConversationItemId<"response">;
        turn: ScopedConversationItemId<"turn"> | null;
      }
    | {
        kind: "usage";
        measurement: SnapshotUsage;
        response: null;
        turn: ScopedConversationItemId<"turn"> | null;
      }
  );

export interface NormalizedCompactionObservation extends NormalizedObservationBase {
  kind: "compaction";
  turn: ScopedConversationItemId<"turn"> | null;
  item: ScopedConversationItemId<"item"> | null;
  encrypted: boolean | null;
  usageEpochAfter: string | null;
}

export interface NormalizedLineageObservation extends NormalizedObservationBase {
  kind: "lineage";
  relationship: "parent" | "forked_from";
  relatedConversation: ConversationIdentity;
  copiedThroughTurn: ScopedConversationItemId<"turn"> | null;
}

export interface NormalizedUnknownObservation extends NormalizedObservationBase {
  kind: "unknown";
  nativeKind: string;
  value: unknown;
}

export type NormalizedSessionObservation =
  | NormalizedMessageObservation
  | NormalizedToolCallObservation
  | NormalizedToolResultObservation
  | NormalizedNativeTurnObservation
  | NormalizedMetadataObservation
  | NormalizedUsageObservation
  | NormalizedCompactionObservation
  | NormalizedLineageObservation
  | NormalizedUnknownObservation;

export type NormalizedObservationKind = NormalizedSessionObservation["kind"];
export type NormalizedObservationOf<K extends NormalizedObservationKind> = Extract<NormalizedSessionObservation, { kind: K }>;

/** A complete newline-terminated record. Partial final lines are retried by the caller. */
export interface LocatedSourceLine {
  raw: string;
  evidence: SourceLineEvidence;
}

/** Boundary immediately after a complete line, bound to the exact preceding bytes. */
export interface ResumeBoundary {
  byteOffset: number;
  prefixHash: string;
}

export interface DecoderCheckpoint<State> {
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
export type DecodeResume<State> =
  | {
      strategy: "replay-prefix";
      readFromByteOffset: 0;
      emitFrom: ResumeBoundary;
      checkpoint: null;
    }
  | {
      strategy: "checkpoint";
      readFromByteOffset: number;
      emitFrom: ResumeBoundary;
      checkpoint: DecoderCheckpoint<State>;
    };

export interface DecodeRequest<State> {
  source: SessionSourceDescriptor;
  lines: AsyncIterable<LocatedSourceLine>;
  resume: DecodeResume<State>;
}

export interface DecodeResult<State> {
  resumeBoundary: ResumeBoundary;
  checkpoint: DecoderCheckpoint<State> | null;
}

export type EmitNormalizedObservation = (observation: NormalizedSessionObservation) => void;

/** Format adapter contract; implementations arrive with their respective decoders. */
export interface SessionFormatDecoder<State = unknown> {
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

/** Explicit compatibility bridge for sources proven to use Claude's legacy session IDs. */
export function legacyClaudeSessionRef(source: SessionSourceDescriptor): string | null {
  if (source.provenance.kind !== "claude-code-transcript") return null;
  if (source.harness !== "claude-code" || source.conversation.harness !== "claude-code") return null;
  if (source.format !== "claude-code-jsonl") return null;
  if (source.namespace !== source.conversation.namespace) return null;
  if (source.provenance.legacySessionId !== source.conversation.nativeId) return null;
  return sessionRef(source.provenance.legacySessionId);
}
