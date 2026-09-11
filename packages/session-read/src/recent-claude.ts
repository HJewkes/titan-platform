import { asObject } from "./text.js";
import type { Json } from "./text.js";
import type { RecentFormatResult, RecentObservedValue, RecentSessionTurn } from "./recent-types.js";
import type { RecentSourceLine } from "./recent-tail.js";
import { observed, oneLine, parseRecentRecord, renderedValue, text, truncate, unknownValue, withNativeOrdinal } from "./recent-values.js";

export function parseRecentClaude(
  lines: readonly RecentSourceLine[],
  truncatedBefore: boolean,
  source: SessionSourceDescriptor,
): RecentFormatResult {
  const errors: RecentFormatResult["errors"] = [];
  const turns: RecentSessionTurn[] = [];
  let model: RecentObservedValue<string> | undefined;
  let branch: RecentObservedValue<string> | undefined;
  let parentSessionId: string | null = null;
  for (const sourceLine of lines) {
    const record = parseRecentRecord(sourceLine, errors);
    if (!record) continue;
    parentSessionId = assertClaudeRecordIdentity(record, source, parentSessionId);
    const line = withNativeOrdinal(sourceLine, record);
    branch = updateObserved(branch, text(record.gitBranch), line);
    if (record.type === "assistant") model = updateObserved(model, assistantModel(record), line);
    const parsed = claudeTurn(record, line);
    if (!parsed) continue;
    turns.push(parsed);
  }
  const malformed = errors.some((error) => error.kind === "malformed_record");
  return {
    turns,
    model: model ?? unknownValue(truncatedBefore, malformed),
    branch: branch ?? unknownValue(truncatedBefore, malformed),
    errors,
    unknown: [],
  };
}

function assertClaudeRecordIdentity(
  record: Json,
  source: SessionSourceDescriptor,
  parentSessionId: string | null,
): string | null {
  const sessionId = text(record.sessionId);
  if (!claudeRecordBelongsToSource(source, record)) {
    throw new TypeError(`Claude transcript record belongs to native session ${String(sessionId)}, expected ${source.conversation.nativeId}`);
  }
  if (!sessionId || sessionId === source.conversation.nativeId) return parentSessionId;
  if (parentSessionId && parentSessionId !== sessionId) throw new TypeError("Claude sidechain window names multiple parent sessions");
  return sessionId;
}

function claudeTurn(record: Json, line: RecentSourceLine): RecentSessionTurn | null {
  const role = record.type;
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const message = asObject(record.message);
  const rendered = renderClaudeContent(message ? message.content : record.content);
  if (!rendered.text.trim()) return null;
  return {
    role,
    kind: rendered.kind,
    timestamp: text(record.timestamp),
    text: rendered.text,
    representation: "native",
    sidechain: typeof record.isSidechain === "boolean" ? record.isSidechain : null,
    toolResultError: rendered.toolResultError,
    evidence: line.evidence,
  };
}

interface RenderedClaudeContent {
  text: string;
  kind: RecentSessionTurn["kind"];
  toolResultError: boolean | null;
}

function renderClaudeContent(content: unknown): RenderedClaudeContent {
  if (typeof content === "string") return { text: content, kind: "message", toolResultError: null };
  if (!Array.isArray(content)) return { text: "", kind: "message", toolResultError: null };
  const blocks = content.map((value) => asObject(value)).filter((value): value is Json => value !== null);
  const kind = blocks.some((block) => block.type === "tool_result")
    ? "tool_result"
    : blocks.some((block) => block.type === "tool_use") ? "tool_call" : "message";
  const states = blocks.filter((block) => block.type === "tool_result").map((block) => booleanOrNull(block.is_error));
  return {
    text: blocks.map(renderClaudeBlock).filter(Boolean).join("\n"),
    kind,
    toolResultError: resultError(states),
  };
}

function renderClaudeBlock(block: Json): string {
  if (block.type === "text") return text(block.text) ?? "";
  if (block.type === "thinking") return `[thinking, ${Array.from(text(block.thinking) ?? "").length} chars]`;
  if (block.type === "tool_use") return `[tool ${text(block.name) ?? "?"}] ${truncate(oneLine(JSON.stringify(block.input ?? {}) ?? ""), 200)}`;
  if (block.type === "tool_result") {
    const marker = block.is_error === true ? ", error" : "";
    return `[tool result${marker}] ${truncate(renderedValue(block.content), 300)}`;
  }
  if (block.type === "image") return "[image]";
  return typeof block.type === "string" ? `[${block.type}]` : "";
}

function resultError(states: readonly (boolean | null)[]): boolean | null {
  if (states.length === 0) return null;
  if (states.some((state) => state === true)) return true;
  return states.every((state) => state === false) ? false : null;
}

function assistantModel(record: Json): string | null {
  return text(asObject(record.message)?.model);
}

function updateObserved(
  current: RecentObservedValue<string> | undefined,
  value: string | null,
  line: RecentSourceLine,
): RecentObservedValue<string> | undefined {
  return value ? observed(value, line) : current;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
import { claudeRecordBelongsToSource } from "./claude-source.js";
import type { SessionSourceDescriptor } from "./normalized.js";
