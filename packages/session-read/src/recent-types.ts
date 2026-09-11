import type { SessionSourceDescriptor, SourceLineEvidence } from "./normalized.js";

export type RecentTurnRole = "user" | "assistant" | "system";
export type RecentTurnKind = "message" | "tool_call" | "tool_result";
export type RecentTurnRepresentation = "native" | "canonical" | "projection-fallback";

export interface RecentSessionTurn {
  role: RecentTurnRole;
  kind: RecentTurnKind;
  timestamp: string | null;
  text: string;
  representation: RecentTurnRepresentation;
  sidechain: boolean | null;
  /** Null means the source did not report error state, or this is not a result. */
  toolResultError: boolean | null;
  evidence: SourceLineEvidence;
}

export type RecentObservedValue<T> =
  | { status: "observed"; value: T; evidence: SourceLineEvidence }
  | { status: "unknown"; reason: RecentUnknownReason };

export type RecentUnknownReason =
  | "outside_window"
  | "not_reported"
  | "source_unavailable"
  | "malformed_records"
  | "unsupported_by_format";

export interface RecentSessionUnknown {
  field: "model" | "branch" | "sidechain" | "tool_result_error";
  reason: RecentUnknownReason;
  evidence?: SourceLineEvidence;
}

export interface RecentSessionReadError {
  kind: "io" | "invalid_utf8" | "malformed_record";
  reason: string;
  evidence?: SourceLineEvidence;
}

export interface RecentSessionTurns {
  status: "read" | "unavailable";
  source: SessionSourceDescriptor;
  turns: readonly RecentSessionTurn[];
  model: RecentObservedValue<string>;
  branch: RecentObservedValue<string>;
  bytesRead: number;
  /** The byte window omitted an earlier part of the source. */
  truncatedBefore: boolean;
  /** The source ended with an incomplete record or grew during the read. */
  truncatedAfter: boolean;
  /** Complete parsed turns were omitted only because maxTurns was reached. */
  truncatedTurns: boolean;
  errors: readonly RecentSessionReadError[];
  unknown: readonly RecentSessionUnknown[];
}

export interface ReadRecentSessionTurnsOptions {
  maxBytes: number;
  maxTurns: number;
  maxCharsPerTurn: number;
}

export interface RecentFormatResult {
  turns: RecentSessionTurn[];
  model: RecentObservedValue<string>;
  branch: RecentObservedValue<string>;
  errors: RecentSessionReadError[];
  unknown: RecentSessionUnknown[];
}
