import type { ConversationIdentity } from "@titan-design/agent-protocol";
import { conversationRef } from "@titan-design/agent-protocol";
import type { NormalizedSessionObservation, SessionSourceDescriptor } from "./normalized.js";
import { scopedConversationItemRef } from "./normalized.js";
import { readSessionObservations } from "./session-observations.js";
import { SessionUsageAccumulator } from "./session-usage.js";
import type { SessionUsageSummary } from "./session-usage.js";

export interface SessionToolSummary {
  callRef: string;
  name: string | null;
  calledAt: string | null;
  resultAt: string | null;
  /** Observed call-to-result span, not harness execution time. */
  durationMs: number | null;
  isError: boolean | null;
  /** Only explicit native toolDenialKind evidence; absence is not permission success. */
  permissionDenialKind: string | null;
  hasCall: boolean;
  hasResult: boolean;
}

export interface SessionSummary {
  conversation: ConversationIdentity;
  observationCount: number;
  /** Copied history is excluded from this conversation's metrics when native evidence identifies it. */
  copiedObservationCount: number;
  messages: { user: number; assistant: number };
  nativeTurnCount: number | null;
  observationSpan: { firstAt: string | null; lastAt: string | null; durationMs: number | null };
  observedModel: string | null;
  cwd: string | null;
  gitBranch: string | null;
  cliVersion: string | null;
  tools: SessionToolSummary[];
  toolErrors: { observed: number; unknownResults: number };
  explicitlyEvidencedPermissionDenials: number;
  compactions: number;
  usage: SessionUsageSummary[];
  usageAvailability: "observed" | "unreported";
  /** Native-valued fields retain their provider names for downstream compatibility. */
  nativeMetadata: Record<string, unknown>;
  unknownKinds: string[];
}

/** A storage-free fold; no transcript observation establishes process liveness. */
export class SessionSummaryAccumulator {
  private readonly usage = new SessionUsageAccumulator();
  private readonly tools = new Map<string, SessionToolSummary>();
  private readonly turns = new Set<string>();
  private readonly messages = new Set<string>();
  private readonly unknownKinds = new Set<string>();
  private readonly summary: SessionSummary;

  constructor(conversation: ConversationIdentity) {
    conversationRef(conversation);
    this.summary = { conversation, observationCount: 0, copiedObservationCount: 0, messages: { user: 0, assistant: 0 },
      nativeTurnCount: null, observationSpan: { firstAt: null, lastAt: null, durationMs: null },
      observedModel: null, cwd: null, gitBranch: null, cliVersion: null, tools: [],
      toolErrors: { observed: 0, unknownResults: 0 }, explicitlyEvidencedPermissionDenials: 0,
      compactions: 0, usage: [], usageAvailability: "unreported", nativeMetadata: Object.create(null) as Record<string, unknown>, unknownKinds: [] };
  }

  add(observation: NormalizedSessionObservation): void {
    if (conversationRef(observation.conversation) !== conversationRef(this.summary.conversation)) {
      throw new TypeError("cannot summarize observations from different conversations");
    }
    this.summary.observationCount++;
    if (observation.historyOrigin) { this.summary.copiedObservationCount++; return; }
    this.observeTimestamp(observation.timestamp);
    for (const entry of observation.nativeExtensions ?? []) this.summary.nativeMetadata[entry.name] = entry.value;
    if (observation.kind === "message") this.observeMessage(observation);
    if (observation.kind === "native_turn") this.turns.add(scopedConversationItemRef(observation.turn));
    if (observation.kind === "tool_call" || observation.kind === "tool_result") this.observeTool(observation);
    if (observation.kind === "usage" && !observation.historyOrigin) this.usage.add(observation.measurement);
    if (observation.kind === "metadata") this.observeMetadata(observation);
    if (observation.kind === "compaction") this.summary.compactions++;
    if (observation.kind === "unknown") this.unknownKinds.add(observation.nativeKind);
  }

  result(): SessionSummary {
    const tools = [...this.tools.values()].map(tool => ({ ...tool,
      durationMs: duration(tool.calledAt, tool.resultAt) }));
    const usage = this.usage.summaries();
    return { ...this.summary, messages: { ...this.summary.messages }, tools, usage,
      nativeMetadata: { ...this.summary.nativeMetadata }, unknownKinds: [...this.unknownKinds],
      nativeTurnCount: this.turns.size || null, usageAvailability: usage.length ? "observed" : "unreported",
      observationSpan: { ...this.summary.observationSpan,
        durationMs: duration(this.summary.observationSpan.firstAt, this.summary.observationSpan.lastAt) },
      toolErrors: { observed: tools.filter(tool => tool.isError === true).length,
        unknownResults: tools.filter(tool => tool.hasResult && tool.isError === null).length },
      explicitlyEvidencedPermissionDenials: tools.filter(tool => tool.permissionDenialKind !== null).length };
  }

  private observeTimestamp(timestamp: string | null): void {
    if (timestamp === null || !Number.isFinite(Date.parse(timestamp))) return;
    const span = this.summary.observationSpan;
    if (span.firstAt === null || Date.parse(timestamp) < Date.parse(span.firstAt)) span.firstAt = timestamp;
    if (span.lastAt === null || Date.parse(timestamp) > Date.parse(span.lastAt)) span.lastAt = timestamp;
  }

  private observeMessage(observation: Extract<NormalizedSessionObservation, { kind: "message" }>): void {
    const key = observation.item ? scopedConversationItemRef(observation.item)
      : JSON.stringify(observation.id);
    if (!this.messages.has(key)) this.summary.messages[observation.role]++;
    this.messages.add(key);
  }

  private observeTool(observation: Extract<NormalizedSessionObservation, { kind: "tool_call" | "tool_result" }>): void {
    const callRef = scopedConversationItemRef(observation.call);
    const tool = this.tools.get(callRef) ?? { callRef, name: null, calledAt: null, resultAt: null,
      durationMs: null, isError: null, permissionDenialKind: null, hasCall: false, hasResult: false };
    if (observation.kind === "tool_call") {
      tool.name = observation.name;
      tool.calledAt = observation.timestamp;
      tool.hasCall = true;
    } else {
      tool.resultAt = observation.timestamp;
      tool.isError = observation.isError;
      tool.hasResult = true;
      const denial = observation.nativeExtensions?.find(entry => entry.name === "toolDenialKind")?.value;
      tool.permissionDenialKind = typeof denial === "string" && denial.trim() ? denial : null;
    }
    this.tools.set(callRef, tool);
  }

  private observeMetadata(observation: Extract<NormalizedSessionObservation, { kind: "metadata" }>): void {
    for (const entry of observation.entries) {
      if (entry.meaning === "native") this.summary.nativeMetadata[entry.name] = entry.value;
      if (typeof entry.value !== "string") continue;
      if (entry.name === "model") this.summary.observedModel = entry.value;
      if (entry.name === "cwd") this.summary.cwd = entry.value;
      if (entry.name === "git_branch") this.summary.gitBranch = entry.value;
      if (entry.name === "cli_version") this.summary.cliVersion = entry.value;
    }
  }
}

function duration(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const result = Date.parse(end) - Date.parse(start);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export async function summarizeSession(source: SessionSourceDescriptor): Promise<SessionSummary> {
  const accumulator = new SessionSummaryAccumulator(source.conversation);
  for await (const observation of readSessionObservations(source)) accumulator.add(observation);
  return accumulator.result();
}
