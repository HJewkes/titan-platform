import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageMeasurement } from "@titan-design/agent-protocol";
import type { NormalizedObservationBase, NormalizedSessionObservation } from "./normalized.js";
import { SessionSummaryAccumulator, summarizeSession } from "./session-summary.js";
import { claudeSourceId } from "./claude-source.js";
import { codexSourceId } from "./codex-discover.js";
import { SessionUsageAccumulator } from "./session-usage.js";

const conversation = { harness: "codex", namespace: "host", nativeId: "thread" };
const call = { conversation, kind: "call" as const, nativeId: "call" };
function base(offset = 0): NormalizedObservationBase {
  return { conversation, historyOrigin: null, timestamp: null,
    id: { sourceId: "source", byteOffset: offset, subrecordIndex: 0 },
    evidence: { line: { sourceId: "source", byteOffset: offset, byteLength: 1,
      contentHash: "hash", lineNumber: 1, nativeOrdinal: null }, subrecord: { index: 0, path: [] } } };
}
function delta(id: string, input: number): Extract<UsageMeasurement, { kind: "delta" }> {
  return { kind: "delta", responseId: id, model: "model", source: "native", cost: null,
    tokens: { input, output: 2, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: input + 2 } };
}
function snapshot(sequence: number, input: number, epoch = "epoch"): UsageMeasurement {
  return { ...delta("ignored", input), kind: "snapshot", scope: "conversation", scopeId: "thread", epoch, sequence };
}

describe("storage-free usage folding", () => {
  it("deduplicates deltas and never adds snapshots or unknown cache categories", () => {
    const usage = new SessionUsageAccumulator();
    usage.add(snapshot(9, 100)); usage.add(delta("a", 10)); usage.add(delta("a", 10)); usage.add(delta("b", 20));
    expect(usage.summaries()).toEqual([expect.objectContaining({ basis: "delta", requestCount: 2,
      inputTokens: 30, tokens: expect.objectContaining({ cachedInput: null, total: 34 }) })]);
  });
  it("orders snapshots, counts reset epochs, and does not assign a model to cumulative totals", () => {
    const usage = new SessionUsageAccumulator();
    usage.add(snapshot(2, 20)); usage.add(snapshot(1, 10)); usage.add(snapshot(1, 5, "reset"));
    expect(usage.summaries()).toEqual([expect.objectContaining({ model: null, basis: "snapshot", inputTokens: 25, requestCount: null })]);
  });
});

describe("session summary evidence", () => {
  it("distinguishes generic errors from native denials and preserves unknown results", () => {
    const summary = new SessionSummaryAccumulator(conversation);
    summary.add({ ...base(), timestamp: "2026-09-11T01:00:00Z", kind: "tool_call", call, item: null,
      name: "shell", namespace: null, input: {}, inputLocator: null });
    summary.add({ ...base(1), timestamp: "2026-09-11T01:00:02Z", kind: "tool_result", call, item: null,
      output: "failure", outputLocator: null, isError: true });
    summary.add({ ...base(2), kind: "tool_result", call: { ...call, nativeId: "unmatched" }, item: null,
      output: "unknown", outputLocator: null, isError: null });
    let result = summary.result();
    expect(result.toolErrors).toEqual({ observed: 1, unknownResults: 1 });
    expect(result.explicitlyEvidencedPermissionDenials).toBe(0);
    expect(result.tools[0]?.durationMs).toBe(2000);
    expect(result.tools[1]).toMatchObject({ hasCall: false, durationMs: null });
    summary.add({ ...base(3), kind: "tool_result", call: { ...call, nativeId: "denied" }, item: null,
      output: "denied", outputLocator: null, isError: true,
      nativeExtensions: [{ name: "toolDenialKind", value: "permission" }] });
    result = summary.result();
    expect(result.explicitlyEvidencedPermissionDenials).toBe(1);
    expect(result.nativeTurnCount).toBeNull();
    expect(result.usageAvailability).toBe("unreported");
    expect(result.observationSpan.durationMs).toBe(2000);
  });
  it("ignores copied-history usage and does not infer observed model from usage", () => {
    const summary = new SessionSummaryAccumulator(conversation);
    const usage: NormalizedSessionObservation = { ...base(), kind: "usage", measurement: delta("response", 4),
      response: { conversation, kind: "response", nativeId: "response" }, turn: null };
    summary.add({ ...usage, historyOrigin: { ...conversation, nativeId: "parent" } });
    expect(summary.result().usageAvailability).toBe("unreported");
    summary.add(usage);
    expect(summary.result().usage[0]?.inputTokens).toBe(4);
    expect(summary.result().observedModel).toBeNull();
    summary.add({ ...base(2), kind: "metadata", scope: "turn", turn: null,
      entries: [{ name: "model", value: "actual", meaning: "normalized" }] });
    expect(summary.result().observedModel).toBe("actual");
    expect(() => summary.add({ ...usage, conversation: { ...conversation, namespace: "other" } })).toThrow(/different conversations/);
  });
});


it("summarizes both formats from temporary sources without graph storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-summary-"));
  try {
    for (const harness of ["claude-code", "codex"]) {
      const nativeId = "fixture";
      const path = join(dir, `${harness === "codex" ? "rollout-" : ""}${nativeId}.jsonl`);
      const records = harness === "claude-code" ? [
        { type: "user", uuid: "turn", sessionId: nativeId, gitBranch: "feature", version: "test", message: { content: "hello" } },
        { type: "assistant", uuid: "reply", sessionId: nativeId, message: { id: "response", model: "actual", content: [{ type: "text", text: "world" }] } },
      ] : [
        { type: "session_meta", payload: { id: nativeId, cli_version: "test", git: { branch: "feature" } } },
        { type: "turn_context", payload: { turn_id: "turn", model: "actual" } },
        { type: "response_item", payload: { type: "message", id: "input", role: "user", content: [{ type: "input_text", text: "hello" }] } },
        { type: "response_item", payload: { type: "message", id: "reply", role: "assistant", content: [{ type: "output_text", text: "world" }] } },
      ];
      await writeFile(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
      const result = await summarizeSession({ sourceId: harness === "codex" ? codexSourceId("test", nativeId, path.split("/").pop()!) : claudeSourceId("test", nativeId), harness,
        namespace: "test", conversation: { harness, namespace: "test", nativeId }, path,
        format: harness === "codex" ? "codex-rollout-jsonl" : "claude-code-jsonl", formatVersion: null,
        provenance: harness === "codex" ? { kind: "codex-rollout", sessionTreeId: null, historyMode: "unknown" }
          : { kind: "claude-code-transcript", legacySessionId: nativeId } });
      expect(result.messages).toEqual({ user: 1, assistant: 1 });
      expect(result.observedModel).toBe("actual");
      expect(result.gitBranch).toBe("feature");
      expect(result.cliVersion).toBe("test");
      expect(result.usageAvailability).toBe("unreported");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("chooses snapshot scope independently after a reset epoch", () => {
  const usage = new SessionUsageAccumulator();
  usage.add(snapshot(2, 20));
  usage.add({ ...snapshot(1, 5, "reset"), scope: "turn", scopeId: "second-turn" } as UsageMeasurement);
  expect(usage.summaries().reduce((total, group) => total + (group.inputTokens ?? 0), 0)).toBe(25);
});

it("keeps explicitly copied history out of the child conversation metrics", () => {
  const summary = new SessionSummaryAccumulator(conversation);
  summary.add({ ...base(), historyOrigin: { ...conversation, nativeId: "parent" },
    timestamp: "2020-01-01T00:00:00Z", kind: "metadata", scope: "conversation", turn: null,
    entries: [{ name: "model", value: "parent-model", meaning: "normalized" }] });
  summary.add({ ...base(1), historyOrigin: { ...conversation, nativeId: "parent" },
    kind: "tool_result", call, item: null, output: "denied", outputLocator: null,
    isError: true, nativeExtensions: [{ name: "toolDenialKind", value: "permission" }] });
  expect(summary.result()).toMatchObject({ copiedObservationCount: 2, tools: [], observedModel: null,
    explicitlyEvidencedPermissionDenials: 0, observationSpan: { firstAt: null } });
});
