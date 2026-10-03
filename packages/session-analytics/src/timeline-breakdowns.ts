import type { ToolFamily } from "@titan-design/session-read";
import type {
  TimelineAgentSpan,
  TimelineErrorBreakdown,
  TimelineFileBreakdown,
  TimelineFileTouch,
  TimelineToolBreakdown,
  TimelineToolCall,
  ToolFamilyCount,
  ToolNameCount,
} from "./timeline-types.js";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function ascending(times: readonly (number | null)[]): number[] {
  return times.filter((time): time is number => time !== null).sort((a, b) => a - b);
}

export function toolBreakdown(calls: readonly TimelineToolCall[]): TimelineToolBreakdown {
  const byName = new Map<string, ToolNameCount>();
  const byFamily = new Map<ToolFamily, ToolFamilyCount>();
  for (const call of calls) {
    const failed = call.outcome === "error" ? 1 : 0;
    const name = byName.get(call.name) ?? { name: call.name, family: call.family, calls: 0, errors: 0, durationMs: 0 };
    name.calls++;
    name.errors += failed;
    name.durationMs += call.durationMs ?? 0;
    byName.set(call.name, name);
    const family = byFamily.get(call.family) ?? { family: call.family, calls: 0, errors: 0, atMs: [] };
    family.calls++;
    family.errors += failed;
    if (call.atMs !== null) family.atMs.push(call.atMs);
    byFamily.set(call.family, family);
  }
  for (const family of byFamily.values()) family.atMs.sort((a, b) => a - b);
  return {
    byName: [...byName.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    byFamily: [...byFamily.values()].sort((a, b) => b.calls - a.calls || a.family.localeCompare(b.family)),
    atMs: ascending(calls.map((call) => call.atMs)),
  };
}

/** A call with a path counts as a write for the editing tools and as a read for every other tool. */
export function fileBreakdown(calls: readonly TimelineToolCall[]): TimelineFileBreakdown {
  const touches = new Map<string, TimelineFileTouch>();
  for (const call of calls) {
    if (!call.filePath) continue;
    const access = WRITE_TOOLS.has(call.name) ? "write" : "read";
    const key = `${access}:${call.filePath}`;
    const touch = touches.get(key) ?? { path: call.filePath, access, atMs: call.atMs, calls: 0 };
    touch.calls++;
    touches.set(key, touch);
  }
  const rows = [...touches.values()].sort((a, b) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity));
  return {
    touches: rows,
    readCount: rows.filter((row) => row.access === "read").length,
    writeCount: rows.filter((row) => row.access === "write").length,
  };
}

export function errorBreakdown(calls: readonly TimelineToolCall[]): TimelineErrorBreakdown {
  const items = calls
    .filter((call) => call.outcome === "error")
    .map((call) => ({
      callId: call.id,
      toolName: call.name,
      turnIndex: call.turnIndex,
      atMs: call.endMs ?? call.atMs,
      message: call.errorMessage ?? "",
      sidechain: call.sidechain,
    }));
  return { rate: calls.length > 0 ? items.length / calls.length : 0, items, atMs: ascending(items.map((item) => item.atMs)) };
}

/** Each subagent dispatch, labelled by the description its input carries. */
export function agentSpans(calls: readonly TimelineToolCall[]): TimelineAgentSpan[] {
  return calls
    .filter((call) => call.family === "subagent")
    .map((call) => ({ callId: call.id, label: call.inputSummary || call.name, startMs: call.atMs, endMs: call.endMs, outcome: call.outcome }));
}
