import { createHash } from "node:crypto";
import path from "node:path";
import type { ConversationIdentity, UsageMeasurement } from "@titan-design/agent-protocol";
import { assertClaudeSessionSource } from "./claude-source.js";
import {
  booleanOrNull,
  extractCompactionSummary,
  messageTextParts,
  metadataEntries,
  nativeExtensionsForRecord,
  selectedSystemFields,
  tokenCounts,
  type ClaudeTextPart,
} from "./claude-values.js";
import type {
  DecodeRequest,
  DecodeResult,
  EmitNormalizedObservation,
  LocatedSourceLine,
  NormalizedNativeExtension,
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
import { TranscriptParseError } from "./read.js";
import { asObject, str, type Json } from "./text.js";

export const CLAUDE_DECODER_ID = "claude-code-transcript";
export const CLAUDE_CHECKPOINT_VERSION = "1";

const COMPACTION_MARKER = "This session is being continued from a previous conversation";

/** Authoritative Claude transcript decoder. State is recovered by replaying the verified prefix. */
export class ClaudeTranscriptDecoder implements SessionFormatDecoder<never> {
  readonly decoderId = CLAUDE_DECODER_ID;
  readonly checkpointVersion = CLAUDE_CHECKPOINT_VERSION;

  async decode(request: DecodeRequest<never>, emit: EmitNormalizedObservation): Promise<DecodeResult<never>> {
    assertClaudeSessionSource(request.source);
    if (request.resume.strategy !== "replay-prefix") throw new TypeError("Claude checkpoints are not implemented; replay the verified prefix");
    const digest = createHash("sha256");
    const context = new ClaudeContext(request.source, request.resume.emitFrom.byteOffset, emit);
    let boundary = boundaryAt(0, digest);
    for await (const line of request.lines) {
      if (line.raw.trim().length > 0) context.handle(line);
      digest.update(line.raw, "utf8").update("\n");
      boundary = boundaryAt(line.evidence.byteOffset + line.evidence.byteLength + 1, digest);
    }
    return { resumeBoundary: boundary, checkpoint: null };
  }

  async readText(locator: SourceTextLocator): Promise<string | null> {
    const { readClaudeText } = await import("./claude-read.js");
    return readClaudeText(locator);
  }
}

class ClaudeContext {
  private line!: LocatedSourceLine;
  private record!: Json;
  private message: Json | null = null;
  private nextIndex = 0;
  private activeTurnId: string | null = null;
  private usageEpoch = 0;
  private parentConversation: ConversationIdentity | null = null;

  constructor(
    private readonly source: SessionSourceDescriptor,
    private readonly emitFrom: number,
    private readonly emit: EmitNormalizedObservation,
  ) {}

  handle(line: LocatedSourceLine): void {
    this.line = line;
    this.record = parseRecord(this.source.path, line);
    this.message = asObject(this.record.message);
    this.nextIndex = 0;
    this.validateLineIdentity();
    this.metadata();
    this.dispatch(str(this.record, "type") ?? "unknown");
  }

  private dispatch(type: string): void {
    switch (type) {
      case "user":
        return this.user();
      case "assistant":
        return this.assistant();
      case "system":
        return this.system();
      case "ai-title":
      case "last-prompt":
      case "mode":
      case "permission-mode":
        return;
      default:
        this.unknown(`claude.${type}`, this.record, []);
    }
  }

  private user(): void {
    const content = this.message?.content;
    const textParts = messageTextParts(content, ["message", "content"]);
    if (textParts.length > 0) {
      const turnId = str(this.record, "uuid");
      if (turnId) {
        this.activeTurnId = turnId;
        this.nativeTurn(turnId);
      }
      this.messageObservation("user", textParts);
      for (const part of textParts) {
        if (part.text.startsWith(COMPACTION_MARKER)) {
          const summary = extractCompactionSummary(part.text);
          this.compaction(part.path, summary ? [{ name: "compactionSummary", value: summary }] : []);
        }
      }
    }

    if (!Array.isArray(content)) return;
    content.forEach((value, index) => {
      const block = asObject(value);
      const type = str(block, "type") ?? "unknown";
      if (type === "tool_result") this.toolResult(block, index);
      else if (type !== "text") this.unknown(`claude.content.${type}`, value, ["message", "content", index]);
    });
  }

  private assistant(): void {
    const content = this.message?.content;
    const textParts = messageTextParts(content, ["message", "content"]);
    if (textParts.length > 0) this.messageObservation("assistant", textParts);
    if (Array.isArray(content)) {
      content.forEach((value, index) => {
        const block = asObject(value);
        const type = str(block, "type") ?? "unknown";
        if (type === "tool_use") this.toolCall(block, index);
        else if (type === "thinking") this.unknown("claude.content.thinking", block?.thinking ?? null, ["message", "content", index, "thinking"]);
        else if (type !== "text") this.unknown(`claude.content.${type}`, value, ["message", "content", index]);
      });
    }
    this.usage();
  }

  private system(): void {
    const subtype = str(this.record, "subtype") ?? "event";
    if (subtype === "compact_boundary") return this.compaction([]);
    this.unknown(`claude.system.${subtype}`, selectedSystemFields(this.record), []);
  }

  private messageObservation(role: "user" | "assistant", parts: readonly ClaudeTextPart[]): void {
    const base = this.base(["message"]);
    const itemId = str(this.record, "uuid") ?? str(this.message, "id");
    this.observe({
      ...base,
      kind: "message",
      role,
      item: itemId ? this.item("item", itemId) : null,
      representation: "canonical",
      content: parts.map((part) => this.textPart(part, base.evidence)),
    });
  }

  private toolCall(block: Json | null, index: number): void {
    const callId = str(block, "id");
    if (!callId) return this.unknown("claude.content.tool_use", block, ["message", "content", index]);
    const input = block?.input;
    const base = this.base(["message", "content", index]);
    const rowItem = str(this.record, "uuid");
    this.observe({
      ...base,
      kind: "tool_call",
      call: this.item("call", callId),
      item: rowItem ? this.item("item", rowItem) : null,
      name: str(block, "name") ?? "unknown",
      namespace: null,
      input,
      inputLocator: block && "input" in block ? this.locator(["message", "content", index, "input"], base.evidence) : null,
    });
  }

  private toolResult(block: Json | null, index: number): void {
    const callId = str(block, "tool_use_id");
    if (!callId) return this.unknown("claude.content.tool_result", block, ["message", "content", index]);
    const output = block?.content;
    const base = this.base(["message", "content", index]);
    const rowItem = str(this.record, "uuid");
    this.observe({
      ...base,
      kind: "tool_result",
      call: this.item("call", callId),
      item: rowItem ? this.item("item", rowItem) : null,
      output,
      outputLocator: block && "content" in block ? this.locator(["message", "content", index, "content"], base.evidence) : null,
      isError: booleanOrNull(block?.is_error),
    });
  }

  private usage(): void {
    const usage = asObject(this.message?.usage);
    if (!usage) return;
    const responseId = str(this.message, "id") ?? str(this.record, "uuid");
    if (!responseId) return this.unknown("claude.message.usage", usage, ["message", "usage"]);
    const tokens = tokenCounts(usage);
    const measurement: UsageMeasurement = {
      kind: "delta",
      responseId,
      model: str(this.message, "model"),
      tokens,
      cost: null,
      source: "claude.message.usage",
    };
    const base = this.base(["message", "usage"]);
    this.observe({
      ...base,
      kind: "usage",
      measurement,
      response: this.item("response", responseId),
      turn: this.activeTurnId ? this.item("turn", this.activeTurnId) : null,
    });
  }

  private nativeTurn(turnId: string): void {
    this.observe({
      ...this.base(["uuid"]),
      kind: "native_turn",
      turn: this.item("turn", turnId),
      rootTurn: null,
      phase: "observed",
    });
  }

  private compaction(path: readonly (string | number)[], extraExtensions: readonly NormalizedNativeExtension[] = []): void {
    this.usageEpoch += 1;
    const rowItem = str(this.record, "uuid");
    const base = this.base(path);
    const nativeExtensions = [...(base.nativeExtensions ?? []), ...extraExtensions];
    this.observe({
      ...base,
      ...(nativeExtensions.length > 0 ? { nativeExtensions } : {}),
      kind: "compaction",
      turn: this.activeTurnId ? this.item("turn", this.activeTurnId) : null,
      item: rowItem ? this.item("item", rowItem) : null,
      encrypted: null,
      usageEpochAfter: `${this.source.sourceId}:usage:${this.usageEpoch}`,
    });
  }

  private metadata(): void {
    const entries = metadataEntries(this.record, this.message);
    if (entries.length === 0) return;
    this.observe({
      ...this.base([]),
      kind: "metadata",
      scope: this.activeTurnId ? "turn" : "conversation",
      turn: this.activeTurnId ? this.item("turn", this.activeTurnId) : null,
      entries,
    });
  }

  private validateLineIdentity(): void {
    const nativeId = str(this.record, "sessionId");
    if (!nativeId || nativeId === this.source.conversation.nativeId) return;
    if (!isSubagentSource(this.source)) {
      throw new TypeError(`Claude transcript ${this.source.sourceId} contains session ${nativeId}`);
    }
    if (this.parentConversation?.nativeId === nativeId) return;
    if (this.parentConversation) throw new TypeError(`Claude sidechain ${this.source.sourceId} names multiple parent sessions`);
    this.parentConversation = { harness: "claude-code", namespace: this.source.namespace, nativeId };
    this.observe({
      ...this.base(["sessionId"]),
      kind: "lineage",
      relationship: "parent",
      relatedConversation: this.parentConversation,
      copiedThroughTurn: null,
    });
  }

  private base(path: readonly (string | number)[]): NormalizedObservationBase {
    return this.baseFrom(this.evidence(path));
  }

  private baseFrom(evidence: SourceEvidence): NormalizedObservationBase {
    const nativeExtensions = nativeExtensionsForRecord(this.record, this.message);
    return {
      ...(nativeExtensions.length > 0 ? { nativeExtensions } : {}),
      id: { sourceId: this.source.sourceId, byteOffset: evidence.line.byteOffset, subrecordIndex: evidence.subrecord.index },
      conversation: this.source.conversation,
      turn: this.activeTurnId ? this.item("turn", this.activeTurnId) : null,
      historyOrigin: null,
      timestamp: str(this.record, "timestamp") || null,
      evidence,
    };
  }

  private evidence(path: readonly (string | number)[]): SourceEvidence {
    return { line: this.line.evidence, subrecord: { index: this.nextIndex++, path } };
  }

  private textPart(part: ClaudeTextPart, evidence: SourceEvidence): NormalizedTextPart {
    return { kind: "text", text: part.text, locator: this.locator(part.path, evidence) };
  }

  private locator(path: readonly (string | number)[], evidence: SourceEvidence): SourceTextLocator {
    return { source: this.source, evidence, selector: { kind: "subrecord-text", path } };
  }

  private item<K extends "turn" | "call" | "item" | "response">(kind: K, nativeId: string): ScopedConversationItemId<K> {
    return { conversation: this.source.conversation, kind, nativeId };
  }

  private observe(observation: NormalizedSessionObservation): void {
    if (observation.evidence.line.byteOffset >= this.emitFrom) this.emit(observation);
  }

  private unknown(nativeKind: string, value: unknown, path: readonly (string | number)[]): void {
    this.observe({ ...this.base(path), kind: "unknown", nativeKind, value });
  }
}

function isSubagentSource(source: SessionSourceDescriptor): boolean {
  return path.basename(source.path) === `agent-${source.conversation.nativeId}.jsonl`;
}

function parseRecord(filePath: string, line: LocatedSourceLine): Json {
  try {
    const parsed = asObject(JSON.parse(line.raw));
    if (!parsed) throw new TypeError("record is not an object");
    return parsed;
  } catch (error) {
    throw new TranscriptParseError(filePath, line.evidence.byteOffset, error);
  }
}

function boundaryAt(byteOffset: number, digest: ReturnType<typeof createHash>): ResumeBoundary {
  return { byteOffset, prefixHash: digest.copy().digest("hex") };
}
