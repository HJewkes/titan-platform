import { createHash } from "node:crypto";
import type { ConversationIdentity } from "@titan-design/agent-protocol";
import type {
  DecodeRequest,
  DecodeResult,
  EmitNormalizedObservation,
  LocatedSourceLine,
  NormalizedObservationBase,
  NormalizedSessionObservation,
  NormalizedTextPart,
  ResumeBoundary,
  ScopedConversationItemId,
  SessionFormatDecoder,
  SessionSourceDescriptor,
  SourceEvidence,
  SourceTextLocator,
} from "./normalized.js";
import { asObject, str, type Json } from "./text.js";
import { CodexProjectionBuffer } from "./codex-projections.js";
import { CodexUsageDecoder, type CodexUsageEmission } from "./codex-usage.js";
import {
  CALL_TYPES,
  COMPACTION_TYPES,
  RESULT_TYPES,
  booleanOrNull,
  boundaryAt,
  finiteNumber,
  hasEncryptedContent,
  parseCodexRecord,
  readCanonicalMessage,
  selectedValue,
  sourceMismatch,
  validateCodexDescriptor,
  type CodexMessage,
} from "./codex-values.js";

export const CODEX_DECODER_ID = "codex-rollout";
export const CODEX_CHECKPOINT_VERSION = "1";

/** Prefix-replay decoder. Checkpoint state is reserved by the shared contract. */
export class CodexRolloutDecoder implements SessionFormatDecoder<never> {
  readonly decoderId = CODEX_DECODER_ID;
  readonly checkpointVersion = CODEX_CHECKPOINT_VERSION;

  async decode(request: DecodeRequest<never>, emit: EmitNormalizedObservation): Promise<DecodeResult<never>> {
    validateCodexDescriptor(request.source);
    if (request.resume.strategy !== "replay-prefix") throw new TypeError("Codex checkpoints are not implemented; replay the verified prefix");
    const digest = createHash("sha256");
    const context = new CodexContext(request.source, request.resume.emitFrom.byteOffset, emit);
    let boundary = boundaryAt(0, digest);
    for await (const line of request.lines) {
      const before = boundaryAt(line.evidence.byteOffset, digest);
      if (line.raw.trim().length > 0) context.handle(line, before);
      digest.update(line.raw, "utf8").update("\n");
      boundary = boundaryAt(line.evidence.byteOffset + line.evidence.byteLength + 1, digest);
    }
    return { resumeBoundary: context.pendingBoundary ?? boundary, checkpoint: null };
  }

  async readText(locator: SourceTextLocator): Promise<string | null> {
    const { readCodexText } = await import("./codex-read.js");
    return readCodexText(locator);
  }
}

class CodexContext {
  private line!: LocatedSourceLine;
  private record!: Json;
  private payload: Json | null = null;
  private nextIndex = 0;
  private activeTurnId: string | null = null;
  private parentThreadId: string | null = null;
  private readonly turnModels = new Map<string, string>();
  private readonly projections = new CodexProjectionBuffer();
  private readonly usage: CodexUsageDecoder;

  constructor(
    private readonly source: SessionSourceDescriptor,
    private readonly emitFrom: number,
    private readonly emit: EmitNormalizedObservation,
  ) {
    this.usage = new CodexUsageDecoder(source.sourceId, source.conversation.nativeId);
  }

  get pendingBoundary(): ResumeBoundary | null {
    return this.projections.boundary;
  }

  handle(line: LocatedSourceLine, before: ResumeBoundary): void {
    this.line = line;
    this.record = parseCodexRecord(this.source.path, line);
    this.payload = asObject(this.record.payload);
    this.nextIndex = 0;
    const ordinal = finiteNumber(this.record.ordinal);
    this.line = { ...line, evidence: { ...line.evidence, nativeOrdinal: ordinal } };
    this.dispatch(str(this.record, "type") ?? "unknown", before);
  }

  private dispatch(type: string, before: ResumeBoundary): void {
    switch (type) {
      case "session_meta":
        return this.sessionMetadata();
      case "turn_context":
        return this.turnContext();
      case "response_item":
        return this.responseItem();
      case "event_msg":
        return this.eventMessage(before);
      case "token_usage_record":
        return this.tokenUsage();
      case "world_state":
        return this.metadata("turn", ["payload"]);
      default:
        return this.unknown(type, this.payload ?? this.record, ["payload"]);
    }
  }

  private sessionMetadata(): void {
    const nativeId = str(this.payload, "id") ?? str(this.payload, "thread_id");
    if (nativeId !== this.source.conversation.nativeId) throw sourceMismatch(this.source, nativeId);
    this.parentThreadId = str(this.payload, "parent_thread_id");
    this.metadata("conversation", ["payload"]);
    if (this.parentThreadId) this.lineage("parent", this.parentThreadId, null, ["payload", "parent_thread_id"]);
    const forkedFrom = str(this.payload, "forked_from_id") ?? str(this.payload, "forkedFromId");
    const cut = str(this.payload, "forked_from_turn_id") ?? str(this.payload, "forkedFromTurnId");
    if (forkedFrom) this.lineage("forked_from", forkedFrom, cut, ["payload", "forked_from_id"]);
  }

  private turnContext(): void {
    const turnId = str(this.payload, "turn_id");
    if (turnId) this.activeTurnId = turnId;
    const model = str(this.payload, "model");
    if (turnId && model) this.turnModels.set(turnId, model);
    if (turnId) this.nativeTurn("observed", turnId, str(this.payload, "root_turn_id"), ["payload", "turn_id"]);
    this.metadata("turn", ["payload"]);
  }

  private responseItem(): void {
    const subtype = str(this.payload, "type") ?? "unknown";
    const message = readCanonicalMessage(this.payload, subtype);
    if (message) return this.canonicalMessage(message);
    if (CALL_TYPES.has(subtype)) return this.toolCall(subtype);
    if (RESULT_TYPES.has(subtype)) return this.toolResult(subtype);
    if (COMPACTION_TYPES.has(subtype)) return this.compaction(["payload"]);
    this.unknown(`response_item.${subtype}`, this.payload, ["payload"]);
  }

  private eventMessage(before: ResumeBoundary): void {
    const subtype = str(this.payload, "type") ?? "unknown";
    if (subtype === "user_message" || subtype === "agent_message") return this.projectedMessage(subtype, before);
    if (subtype === "task_started") return this.turnEvent("started");
    if (subtype === "task_complete") return this.finishTurn("completed");
    if (subtype === "turn_aborted") return this.finishTurn("aborted");
    if (subtype === "token_count") return this.projectedUsage();
    if (subtype === "thread_settings_applied") return this.metadata("turn", ["payload"]);
    this.unknown(`event_msg.${subtype}`, this.payload, ["payload"]);
  }

  private canonicalMessage(message: CodexMessage): void {
    const text = message.parts.map((part) => part.text).join("\n");
    this.projections.match(message.role, text);
    const base = this.base(["payload"]);
    const itemId = str(this.payload, "id");
    this.observe({
      ...base,
      kind: "message",
      role: message.role,
      item: itemId ? this.item("item", itemId) : null,
      representation: "canonical",
      content: message.parts.map((part) => this.textPart(part.text, part.path, base.evidence)),
    });
  }

  private projectedMessage(subtype: string, before: ResumeBoundary): void {
    const role = subtype === "user_message" ? "user" : "assistant";
    const text = str(this.payload, "message") ?? str(this.payload, "text");
    if (!text) return this.unknown(`event_msg.${subtype}`, this.payload, ["payload"]);
    const path = ["payload", str(this.payload, "message") ? "message" : "text"] as const;
    this.projections.add({ role, text, line: this.line.evidence, timestamp: this.timestamp(), path, boundary: before });
  }

  private flushProjectedMessages(): void {
    for (const pending of this.projections.drain()) {
      const evidence = this.evidence(pending.path, pending.line);
      this.observe({
        ...this.baseFrom(evidence, pending.timestamp),
        kind: "message",
        role: pending.role,
        item: null,
        representation: "projection-fallback",
        content: [this.textPart(pending.text, pending.path, evidence)],
      });
    }
  }

  private toolCall(subtype: string): void {
    const callId = str(this.payload, "call_id");
    if (!callId) return this.unknown(`response_item.${subtype}`, this.payload, ["payload"]);
    const { value, path } = selectedValue(this.payload, ["input", "arguments", "query"]);
    const base = this.base(["payload"]);
    const itemId = str(this.payload, "id");
    this.observe({
      ...base,
      kind: "tool_call",
      call: this.item("call", callId),
      item: itemId ? this.item("item", itemId) : null,
      name: str(this.payload, "name") ?? subtype,
      namespace: str(this.payload, "namespace"),
      input: value,
      inputLocator: path ? this.locator(["payload", path], base.evidence) : null,
    });
  }

  private toolResult(subtype: string): void {
    const callId = str(this.payload, "call_id");
    if (!callId) return this.unknown(`response_item.${subtype}`, this.payload, ["payload"]);
    const { value, path } = selectedValue(this.payload, ["output", "result"]);
    const base = this.base(["payload"]);
    const itemId = str(this.payload, "id");
    this.observe({
      ...base,
      kind: "tool_result",
      call: this.item("call", callId),
      item: itemId ? this.item("item", itemId) : null,
      output: value,
      outputLocator: path ? this.locator(["payload", path], base.evidence) : null,
      isError: booleanOrNull(this.payload?.is_error),
    });
  }

  private turnEvent(phase: "started"): void {
    const turnId = str(this.payload, "turn_id") ?? this.activeTurnId;
    if (!turnId) return this.unknown(`event_msg.task_${phase}`, this.payload, ["payload"]);
    this.activeTurnId = turnId;
    this.nativeTurn(phase, turnId, str(this.payload, "root_turn_id"), ["payload", "turn_id"]);
  }

  private finishTurn(phase: "completed" | "aborted"): void {
    this.flushProjectedMessages();
    const turnId = str(this.payload, "turn_id") ?? this.activeTurnId;
    if (turnId) this.nativeTurn(phase, turnId, str(this.payload, "root_turn_id"), ["payload", "turn_id"]);
    else this.unknown(`event_msg.${phase}`, this.payload, ["payload"]);
    this.activeTurnId = null;
  }

  private nativeTurn(phase: "started" | "completed" | "aborted" | "observed", turnId: string, rootId: string | null, path: readonly (string | number)[]): void {
    this.observe({
      ...this.base(path),
      kind: "native_turn",
      turn: this.item("turn", turnId),
      rootTurn: rootId ? this.item("turn", rootId, this.rootConversation()) : null,
      phase,
    });
  }

  private tokenUsage(): void {
    const turnId = str(this.payload, "turn_id");
    const model = turnId ? (this.turnModels.get(turnId) ?? null) : null;
    for (const usage of this.usage.raw(this.payload, model, this.sequence())) this.emitUsage(usage);
  }

  private projectedUsage(): void {
    for (const usage of this.usage.projected(this.payload, this.activeTurnId, this.sequence())) this.emitUsage(usage);
  }

  private emitUsage(usage: CodexUsageEmission): void {
    const base = this.base(usage.path);
    const turn = usage.turnId ? this.item("turn", usage.turnId) : null;
    if (usage.measurement.kind === "delta") {
      this.observe({ ...base, kind: "usage", measurement: usage.measurement, response: this.item("response", usage.measurement.responseId), turn });
    } else {
      this.observe({ ...base, kind: "usage", measurement: usage.measurement, response: null, turn });
    }
  }

  private compaction(path: readonly (string | number)[]): void {
    this.usage.compact();
    const itemId = str(this.payload, "id");
    this.observe({
      ...this.base(path),
      kind: "compaction",
      turn: this.activeTurnId ? this.item("turn", this.activeTurnId) : null,
      item: itemId ? this.item("item", itemId) : null,
      encrypted: hasEncryptedContent(this.payload),
      usageEpochAfter: this.usage.epoch(),
    });
  }

  private lineage(relationship: "parent" | "forked_from", nativeId: string, cut: string | null, path: readonly (string | number)[]): void {
    const related = this.conversation(nativeId);
    this.observe({
      ...this.base(path),
      kind: "lineage",
      relationship,
      relatedConversation: related,
      copiedThroughTurn: cut ? this.item("turn", cut, related) : null,
    });
  }

  private metadata(scope: "source" | "conversation" | "turn", path: readonly (string | number)[]): void {
    if (!this.payload) return;
    const normalized = new Set(["id", "thread_id", "session_id", "parent_thread_id", "turn_id", "root_turn_id", "model", "cwd", "cli_version", "git_branch"]);
    const entries = Object.entries(this.payload).map(([name, value]) => ({ name, value, meaning: normalized.has(name) ? "normalized" as const : "native" as const }));
    const branch = str(this.payload, "git_branch") ?? str(this.payload, "gitBranch") ?? str(asObject(this.payload.git), "branch");
    if (branch && !("git_branch" in this.payload)) entries.push({ name: "git_branch", value: branch, meaning: "normalized" });
    this.observe({
      ...this.base(path),
      kind: "metadata",
      scope,
      turn: this.activeTurnId ? this.item("turn", this.activeTurnId) : null,
      entries,
    });
  }

  private unknown(nativeKind: string, value: unknown, path: readonly (string | number)[]): void {
    this.observe({ ...this.base(path), kind: "unknown", nativeKind, value });
  }

  private base(path: readonly (string | number)[]): NormalizedObservationBase {
    return this.baseFrom(this.evidence(path), this.timestamp());
  }

  private baseFrom(evidence: SourceEvidence, timestamp: string | null): NormalizedObservationBase {
    return {
      id: { sourceId: this.source.sourceId, byteOffset: evidence.line.byteOffset, subrecordIndex: evidence.subrecord.index },
      conversation: this.source.conversation,
      turn: this.activeTurnId ? this.item("turn", this.activeTurnId) : null,
      historyOrigin: null,
      timestamp,
      evidence,
    };
  }

  private evidence(path: readonly (string | number)[], line = this.line.evidence): SourceEvidence {
    return { line, subrecord: { index: this.nextIndex++, path } };
  }

  private textPart(text: string, path: readonly (string | number)[], evidence: SourceEvidence): NormalizedTextPart {
    return { kind: "text", text, locator: this.locator(path, evidence) };
  }

  private locator(path: readonly (string | number)[], evidence: SourceEvidence) {
    return { source: this.source, evidence, selector: { kind: "subrecord-text" as const, path } };
  }

  private observe(observation: NormalizedSessionObservation): void {
    if (observation.evidence.line.byteOffset >= this.emitFrom) this.emit(observation);
  }

  private item<K extends "turn" | "call" | "item" | "response">(kind: K, nativeId: string, conversation = this.source.conversation): ScopedConversationItemId<K> {
    return { conversation, kind, nativeId };
  }

  private conversation(nativeId: string): ConversationIdentity {
    return { harness: "codex", namespace: this.source.namespace, nativeId };
  }

  private rootConversation(): ConversationIdentity {
    return this.parentThreadId ? this.conversation(this.parentThreadId) : this.source.conversation;
  }

  private timestamp(): string | null {
    return str(this.record, "timestamp");
  }

  private sequence(): number {
    return this.line.evidence.nativeOrdinal ?? this.line.evidence.byteOffset;
  }

  private modelForActiveTurn(): string | null {
    return this.activeTurnId ? (this.turnModels.get(this.activeTurnId) ?? null) : null;
  }
}
