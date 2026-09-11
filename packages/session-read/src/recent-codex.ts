import { CALL_TYPES, RESULT_TYPES, booleanOrNull, readCanonicalMessage, selectedValue } from "./codex-values.js";
import { asObject } from "./text.js";
import type { Json } from "./text.js";
import type { RecentFormatResult, RecentObservedValue, RecentSessionTurn } from "./recent-types.js";
import type { RecentSourceLine } from "./recent-tail.js";
import { observed, oneLine, parseRecentRecord, renderedValue, text, truncate, unknownValue, withNativeOrdinal } from "./recent-values.js";

interface Candidate {
  turn: RecentSessionTurn;
  sequence: number;
  projectionKey?: string;
  canonicalKey?: string;
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
  private segment = 0;
  private sequence = 0;
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
        throw new TypeError(`Codex rollout record belongs to native thread ${observedId}, expected ${this.expectedThreadId}`);
      }
    }
  }

  result(): RecentFormatResult {
    const malformed = this.errors.some((error) => error.kind === "malformed_record");
    return {
      turns: deduplicateProjections(this.candidates),
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
    if (subtype === "task_started") {
      this.segment += 1;
      return;
    }
    if (subtype === "task_complete" || subtype === "turn_aborted") {
      this.segment += 1;
      return;
    }
    if (subtype !== "user_message" && subtype !== "agent_message") return;
    const value = text(payload?.message) ?? text(payload?.text);
    if (!value) return;
    const role = subtype === "user_message" ? "user" : "assistant";
    this.add(messageTurn(role, value, timestamp, "projection-fallback", line), { projectionKey: this.key(role, value) });
  }

  private responseItem(payload: Json | null, timestamp: string | null, line: RecentSourceLine): void {
    const subtype = text(payload?.type) ?? "";
    const message = readCanonicalMessage(payload, subtype);
    if (message) {
      const value = message.parts.map((part) => part.text).join("\n");
      this.add(messageTurn(message.role, value, timestamp, "canonical", line), { canonicalKey: this.key(message.role, value) });
      return;
    }
    if (CALL_TYPES.has(subtype)) this.add(toolCallTurn(payload, subtype, timestamp, line));
    if (RESULT_TYPES.has(subtype)) this.add(toolResultTurn(payload, timestamp, line));
  }

  private add(turn: RecentSessionTurn, keys: Pick<Candidate, "projectionKey" | "canonicalKey"> = {}): void {
    this.candidates.push({ turn, sequence: this.sequence++, ...keys });
  }

  private key(role: "user" | "assistant", value: string): string {
    return `${this.segment}\u0000${role}\u0000${value}`;
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
    text: `[tool ${qualified}] ${truncate(oneLine(JSON.stringify(selected.value) ?? ""), 200)}`,
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

function deduplicateProjections(candidates: readonly Candidate[]): RecentSessionTurn[] {
  const canonical = new Map<string, number>();
  for (const item of candidates) {
    if (item.canonicalKey) canonical.set(item.canonicalKey, (canonical.get(item.canonicalKey) ?? 0) + 1);
  }
  return candidates
    .filter((item) => !item.projectionKey || !consume(canonical, item.projectionKey))
    .sort((left, right) => left.sequence - right.sequence)
    .map((item) => item.turn);
}

function consume(counts: Map<string, number>, key: string): boolean {
  const count = counts.get(key) ?? 0;
  if (count <= 0) return false;
  counts.set(key, count - 1);
  return true;
}

function updateObserved(
  current: RecentObservedValue<string> | undefined,
  value: string | null,
  line: RecentSourceLine,
): RecentObservedValue<string> | undefined {
  return value ? observed(value, line) : current;
}
