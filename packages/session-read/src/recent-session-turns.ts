import { assertClaudeSessionSource, CLAUDE_TRANSCRIPT_FORMAT } from "./claude-source.js";
import { CODEX_ROLLOUT_FORMAT } from "./codex-discover.js";
import { validateCodexDescriptor } from "./codex-values.js";
import type { SessionSourceDescriptor } from "./normalized.js";
import { parseRecentClaude } from "./recent-claude.js";
import { parseRecentCodex } from "./recent-codex.js";
import { readRecentTail, readRecentTailSync, type RecentSourceLine, type RecentTailRead } from "./recent-tail.js";
import type {
  ReadRecentSessionTurnsOptions,
  RecentFormatResult,
  RecentObservedValue,
  RecentSessionTurns,
  RecentSessionUnknown,
} from "./recent-types.js";
import { truncate } from "./recent-values.js";

export async function readRecentSessionTurns(
  source: SessionSourceDescriptor,
  options: ReadRecentSessionTurnsOptions,
): Promise<RecentSessionTurns> {
  validateOptions(options);
  validateSource(source);
  const tail = await readRecentTail(source.sourceId, source.path, options.maxBytes);
  return assembleResult(source, options, tail);
}

export function readRecentSessionTurnsSync(
  source: SessionSourceDescriptor,
  options: ReadRecentSessionTurnsOptions,
): RecentSessionTurns {
  validateOptions(options);
  validateSource(source);
  return assembleResult(source, options, readRecentTailSync(source.sourceId, source.path, options.maxBytes));
}

function assembleResult(
  source: SessionSourceDescriptor,
  options: ReadRecentSessionTurnsOptions,
  tail: RecentTailRead,
): RecentSessionTurns {
  if (tail.status === "unavailable") return unavailable(source, tail.reason);
  const parsed = parseFormat(source, tail.lines, tail.truncatedBefore);
  const errors = [...tail.errors, ...parsed.errors];
  const turns = parsed.turns.slice(-options.maxTurns).map((turn) => ({
    ...turn,
    text: truncate(turn.text, options.maxCharsPerTurn),
  }));
  const model = accountForUnreadRecords(parsed.model, tail.truncatedBefore, errors.length > 0);
  const branch = accountForUnreadRecords(parsed.branch, tail.truncatedBefore, errors.length > 0);
  return {
    status: "read",
    source,
    turns,
    model,
    branch,
    bytesRead: tail.bytesRead,
    truncatedBefore: tail.truncatedBefore,
    truncatedAfter: tail.truncatedAfter,
    truncatedTurns: parsed.turns.length > options.maxTurns,
    errors,
    unknown: collectUnknown(turns, model, branch),
  };
}

function validateOptions(options: ReadRecentSessionTurnsOptions): void {
  positiveInteger(options.maxBytes, "maxBytes");
  positiveInteger(options.maxTurns, "maxTurns");
  positiveInteger(options.maxCharsPerTurn, "maxCharsPerTurn");
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
}

function validateSource(source: SessionSourceDescriptor): void {
  if (source.format === CLAUDE_TRANSCRIPT_FORMAT) return assertClaudeSessionSource(source);
  if (source.format === CODEX_ROLLOUT_FORMAT) return validateCodexDescriptor(source);
  throw new TypeError(`recent session turns do not support format ${source.format}`);
}

function parseFormat(
  source: SessionSourceDescriptor,
  lines: readonly RecentSourceLine[],
  truncatedBefore: boolean,
): RecentFormatResult {
  return source.format === CLAUDE_TRANSCRIPT_FORMAT
    ? parseRecentClaude(lines, truncatedBefore, source)
    : parseRecentCodex(lines, truncatedBefore, source.conversation.nativeId);
}

function unavailable(source: SessionSourceDescriptor, reason: string): RecentSessionTurns {
  return {
    status: "unavailable",
    source,
    turns: [],
    model: { status: "unknown", reason: "source_unavailable" },
    branch: { status: "unknown", reason: "source_unavailable" },
    bytesRead: 0,
    truncatedBefore: false,
    truncatedAfter: false,
    truncatedTurns: false,
    errors: [{ kind: "io", reason }],
    unknown: [
      { field: "model", reason: "source_unavailable" },
      { field: "branch", reason: "source_unavailable" },
    ],
  };
}

function accountForUnreadRecords(
  value: RecentObservedValue<string>,
  truncatedBefore: boolean,
  malformed: boolean,
): RecentObservedValue<string> {
  if (value.status === "observed") return value;
  if (truncatedBefore) return { status: "unknown", reason: "outside_window" };
  return malformed ? { status: "unknown", reason: "malformed_records" } : value;
}

function collectUnknown(
  turns: RecentSessionTurns["turns"],
  model: RecentObservedValue<string>,
  branch: RecentObservedValue<string>,
): RecentSessionUnknown[] {
  const unknown: RecentSessionUnknown[] = [];
  if (model.status === "unknown") unknown.push({ field: "model", reason: model.reason });
  if (branch.status === "unknown") unknown.push({ field: "branch", reason: branch.reason });
  for (const turn of turns) collectTurnUnknown(turn, unknown);
  return unknown;
}

function collectTurnUnknown(turn: RecentSessionTurns["turns"][number], unknown: RecentSessionUnknown[]): void {
  if (turn.sidechain === null) {
    const reason = turn.representation === "native" ? "not_reported" : "unsupported_by_format";
    unknown.push({ field: "sidechain", reason, evidence: turn.evidence });
  }
  if (turn.kind === "tool_result" && turn.toolResultError === null) {
    unknown.push({ field: "tool_result_error", reason: "not_reported", evidence: turn.evidence });
  }
}

export type {
  ReadRecentSessionTurnsOptions,
  RecentObservedValue,
  RecentSessionReadError,
  RecentSessionTurn,
  RecentSessionTurns,
  RecentSessionUnknown,
  RecentTurnKind,
  RecentTurnRepresentation,
  RecentTurnRole,
  RecentUnknownReason,
} from "./recent-types.js";
