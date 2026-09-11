import { conversationRef } from "@titan-design/agent-protocol";
import { normalizedSearchText, SPAN_TEXT_CAP, scopedConversationItemRef, type NormalizedSessionObservation as Observation, type SourceTextLocator } from "@titan-design/session-read";
import type { SessionGraph } from "./graph.js";

/** Persist structural evidence only; prose remains in the source and transient FTS input. */
export function insertObservation(graph: SessionGraph, transcriptId: number, o: Observation): void {
  graph.db.prepare(`INSERT INTO normalized_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    transcriptId, o.evidence.line.byteOffset, o.evidence.subrecord.index, o.evidence.line.byteLength,
    conversationRef(o.conversation), o.kind, o.timestamp,
    "turn" in o && o.turn ? scopedConversationItemRef(o.turn) : null,
    "call" in o ? scopedConversationItemRef(o.call) : null,
    "item" in o && o.item ? scopedConversationItemRef(o.item) : null,
    o.kind === "native_turn" ? o.phase : null,
    o.kind === "tool_result" && o.isError !== null ? Number(o.isError) : null,
    o.kind === "usage" ? JSON.stringify(o.measurement) : null,
    o.kind === "metadata" ? JSON.stringify(o.entries.filter(e => ["cwd", "model", "cli_version", "git_branch", "title"].includes(e.name))) : null,
    o.historyOrigin ? conversationRef(o.historyOrigin) : null,
    o.kind === "lineage" ? conversationRef(o.relatedConversation) : null,
    o.kind === "lineage" ? o.relationship : null,
  );
}

export interface ObservationText { field: string; text: string; locator: SourceTextLocator }
export function observationText(o: Observation): ObservationText[] {
  if (o.kind === "message") return o.content.map(p => ({ field: o.role === "user" ? "prompt" : "assistant_response", text: p.text.slice(0, SPAN_TEXT_CAP), locator: p.locator }));
  if (o.kind === "tool_call" && o.inputLocator) return [{ field: "tool_input", text: normalizedSearchText(o.input), locator: o.inputLocator }];
  if (o.kind === "tool_result" && o.outputLocator) return [{ field: "tool_result", text: normalizedSearchText(o.output), locator: o.outputLocator }];
  return [];
}
