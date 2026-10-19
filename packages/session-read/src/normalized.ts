import { conversationItemRef } from "@titan-design/agent-protocol";
import type { ScopedConversationItemId, SessionSourceDescriptor } from "@titan-design/agent-protocol/harness";
import { sessionRef } from "./refs.js";

export type {
  SessionSourceDescriptor,
  SessionSourceProvenance,
  SourceLineEvidence,
  SourceSubrecordEvidence,
  SourceEvidence,
  ObservationIdentity,
  ConversationItemKind,
  ScopedConversationItemId,
  SourceTextLocator,
  NormalizedTextPart,
  NormalizedNativeExtension,
  NormalizedObservationBase,
  NormalizedMessageObservation,
  NormalizedToolCallObservation,
  NormalizedToolResultObservation,
  NormalizedNativeTurnObservation,
  NormalizedMetadataObservation,
  CacheWriteSplit,
  NormalizedUsageObservation,
  NormalizedCompactionObservation,
  NormalizedLineageObservation,
  NormalizedUnknownObservation,
  NormalizedSessionObservation,
  NormalizedObservationKind,
  NormalizedObservationOf,
  LocatedSourceLine,
  ResumeBoundary,
  DecoderCheckpoint,
  DecodeResume,
  DecodeRequest,
  DecodeResult,
  EmitNormalizedObservation,
  SessionFormatDecoder,
} from "@titan-design/agent-protocol/harness";

export function scopedConversationItemRef(item: ScopedConversationItemId): string {
  return conversationItemRef(item.conversation, item.kind, item.nativeId);
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
