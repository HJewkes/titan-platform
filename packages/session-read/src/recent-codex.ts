import { CodexProjectionBuffer } from "./codex-projections.js";
import { CALL_TYPES, RESULT_TYPES, readCanonicalMessage, selectedValue } from "./codex-values.js";
import { SessionIdentityError } from "./recent-claude.js";
import { asObject, booleanOrNull } from "./text.js";
import type { Json } from "./text.js";
import type { RecentFormatResult, RecentObservedValue, RecentSessionTurn } from "./recent-types.js";
import type { RecentSourceLine } from "./recent-tail.js";
import { observed, oneLine, parseRecentRecord, renderedValue, text, truncate, unknownValue, withNativeOrdinal } from "./recent-values.js";

interface Candidate {
  turn: RecentSessionTurn;
  superseded?: boolean;
}

export function parseRecentCodex(
  lines: readonly RecentSourceLine[],
  truncatedBefore: boolean,
  expectedThreadId: string,
): RecentFormatResult {
  const collector = new RecentCodexCollector(truncatedBefore, expectedThreadId);
  for (const line of lines) collector.handle(line);
  return collector.result();
}

class RecentCodexCollector {
  private readonly errors: RecentFormatResult["errors"] = [];
  private readonly candidates: Candidate[] = [];
  private readonly projections = new CodexProjectionBuffer<Candidate>();
  private model: RecentObservedValue<string> | undefined;
  private branch: RecentObservedValue<string> | undefined;

  constructor(
    private readonly truncatedBefore: boolean,
    private readonly expectedThreadId: string,
  ) {}

  handle(sourceLine: RecentSourceLine): void {
    const record = parseRecentRecord(sourceLine, this.errors);
    if (!record) return;
    const line = withNativeOrdinal(sourceLine, record);
    const payload = asObject(record.payload);
    this.assertIdentity(record, payload);
    const timestamp = text(record.timestamp);
    this.observeMetadata(record, payload, line);
    const type = text(record.type);
    if (type === "event_msg") this.eventMessage(payload, timestamp, line);
    if (type === "response_item") this.responseItem(payload, timestamp, line);
  }

  private assertIdentity(record: Json, payload: Json | null): void {
    const explicit = text(record.thread_id) ?? text(payload?.thread_id);
    const sessionMeta = record.type === "session_meta" ? text(payload?.id) : null;
    for (const observedId of [explicit, sessionMeta]) {
      if (observedId && observedId !== this.expectedThreadId) {
        throw new SessionIdentityError(`Codex rollout record belongs to native thread ${observedId}, expected ${this.expectedThreadId}`, "foreign_native_session");
      }
    }
  }

  result(): RecentFormatResult {
    const malformed = this.errors.some((error) => error.kind === "malformed_record");
    return {
      turns: this.candidates.filter((item) => !item.superseded).map((item) => item.turn),
      model: this.model ?? unknownValue(this.truncatedBefore, malformed),
      branch: this.branch ?? unknownValue(this.truncatedBefore, malformed),
      errors: this.errors,
      unknown: [],
    };
  }

  private observeMetadata(record: Json, payload: Json | null, line: RecentSourceLine): void {
    if (!payload) return;
    if (record.type === "turn_context") this.model = updateObserved(this.model, text(payload.model), line);
    const branch = text(payload.gitBranch) ?? text(payload.git_branch) ?? text(asObject(payload.git)?.branch);
    this.branch = updateObserved(this.branch, branch, line);
  }

  private eventMessage(payload: Json | null, timestamp: string | null, line: RecentSourceLine): void {
    const subtype = text(payload?.type);
    if (subtype === "task_complete" || subtype === "turn_aborted") {
      this.projections.drain();
      return;
    }
    if (subtype !== "user_message" && subtype !== "agent_message") return;
    const value = text(payload?.message) ?? text(payload?.text);
    if (!value) return;
    const role = subtype === "user_message" ? "user" : "assistant";
    const candidate = this.add(messageTurn(role, value, timestamp, "projection-fallback", line));
    if (!this.projections.addProjection(role, value, candidate)) candidate.superseded = true;
  }

  private responseItem(payload: Json | null, timestamp: string | null, line: RecentSourceLine): void {
    const subtype = text(payload?.type) ?? "";
    const message = readCanonicalMessage(payload, subtype);
    if (message) {
      const value = message.parts.map((part) => part.text).join("\n");
      const projection = this.projections.addCanonical(message.role, value);
      if (projection) projection.superseded = true;
      this.add(messageTurn(message.role, value, timestamp, "canonical", line));
      return;
    }
    if (CALL_TYPES.has(subtype)) this.add(toolCallTurn(payload, subtype, timestamp, line));
    if (RESULT_TYPES.has(subtype)) this.add(toolResultTurn(payload, timestamp, line));
  }

  private add(turn: RecentSessionTurn): Candidate {
    const candidate: Candidate = { turn };
    this.candidates.push(candidate);
    return candidate;
  }
}

function messageTurn(
  role: "user" | "assistant",
  value: string,
  timestamp: string | null,
  representation: "canonical" | "projection-fallback",
  line: RecentSourceLine,
): RecentSessionTurn {
  return {
    role,
    kind: "message",
    timestamp,
    text: value,
    representation,
    sidechain: null,
    toolResultError: null,
    evidence: line.evidence,
  };
}

function toolCallTurn(payload: Json | null, subtype: string, timestamp: string | null, line: RecentSourceLine): RecentSessionTurn {
  const selected = selectedValue(payload, ["input", "arguments", "query"]);
  const namespace = text(payload?.namespace);
  const name = text(payload?.name) ?? subtype;
  const qualified = namespace ? `${namespace}.${name}` : name;
  return {
    role: "assistant",
    kind: "tool_call",
    timestamp,
    text: `[tool ${qualified}] ${truncate(oneLine(JSON.stringify(selected.value)), 200)}`,
    representation: "canonical",
    sidechain: null,
    toolResultError: null,
    evidence: line.evidence,
  };
}

function toolResultTurn(payload: Json | null, timestamp: string | null, line: RecentSourceLine): RecentSessionTurn {
  const selected = selectedValue(payload, ["output", "result"]);
  const error = booleanOrNull(payload?.is_error);
  return {
    role: "user",
    kind: "tool_result",
    timestamp,
    text: `[tool result${error === true ? ", error" : ""}] ${truncate(renderedValue(selected.value), 300)}`,
    representation: "canonical",
    sidechain: null,
    toolResultError: error,
    evidence: line.evidence,
  };
}

function updateObserved(
  current: RecentObservedValue<string> | undefined,
  value: string | null,
  line: RecentSourceLine,
): RecentObservedValue<string> | undefined {
  return value ? observed(value, line) : current;
}
