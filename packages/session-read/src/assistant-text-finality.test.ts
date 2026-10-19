import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assistantTextFinality } from "./assistant-text-finality.js";
import { claudeSourceFromPath } from "./claude-source.js";
import { codexSourceFromPath } from "./codex-discover.js";
import { readSessionObservations } from "./session-observations.js";
import type { NormalizedSessionObservation } from "./normalized.js";

type Harness = "claude-code" | "codex";
type RecordValue = Record<string, unknown>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const text = (value: string) => ({ type: "text", text: value });
const thinking = { type: "thinking", thinking: "synthetic reasoning" };
const call = { type: "tool_use", id: "call", name: "Read", input: { file_path: "synthetic.ts" } };
const claudeAssistant = (content: readonly unknown[]): RecordValue => ({
  type: "assistant", sessionId: "synthetic-session",
  message: { role: "assistant", model: "fixture-model", content },
});
const envelope = (type: string, payload: RecordValue): RecordValue => ({
  timestamp: "2026-10-17T12:00:00Z", type, payload,
});
const codexText = (value: string) => envelope("response_item", {
  type: "message", role: "assistant", content: [{ type: "output_text", text: value }],
});
const codexCall = () => envelope("response_item", {
  type: "function_call", call_id: "call", name: "read", arguments: "{}",
});
const complete = () => envelope("event_msg", { type: "task_complete", turn_id: "turn" });
const start = () => envelope("event_msg", { type: "task_started", turn_id: "turn" });

async function observe(harness: Harness, records: readonly RecordValue[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "titan-s09-finality-"));
  roots.push(root);
  const file = path.join(root, harness === "claude-code" ? "synthetic-session.jsonl" : "rollout.jsonl");
  const prefix = harness === "codex" ? [envelope("session_meta", { id: "synthetic-session" }), start()] : [];
  writeFileSync(file, [...prefix, ...records].map(record => JSON.stringify(record)).join("\n") + "\n");
  const source = harness === "claude-code" ? claudeSourceFromPath(file, "fixture") : await codexSourceFromPath(file, "fixture");
  if (source === null) throw new Error("synthetic descriptor unavailable");
  const observations: NormalizedSessionObservation[] = [];
  for await (const observation of readSessionObservations(source)) observations.push(observation);
  const finality = assistantTextFinality();
  for (const observation of observations) finality.add(observation);
  const result = finality.hasFinalText();
  // Capture actual decoder coordinates and semantic result before assertions.
  const receipts = process.env.S09_FINALITY_RECEIPT_ROOT;
  if (receipts !== undefined) {
    if (!path.isAbsolute(receipts)) throw new Error("S09 receipt root must be absolute");
    mkdirSync(receipts, { recursive: true });
    writeFileSync(path.join(receipts, path.basename(root) + ".json"), JSON.stringify({
    harness, result, observations: observations.map(observation => ({
      kind: observation.kind, offset: observation.evidence.line.byteOffset,
      path: observation.evidence.subrecord.path,
      ...(observation.kind === "message" ? { role: observation.role, representation: observation.representation,
        texts: observation.content.map(part => part.text) } : {}),
      ...(observation.kind === "unknown" ? { nativeKind: observation.nativeKind } : {}),
    })),
    }, null, 2) + "\n", { flag: "wx" });
  }
  return { result, observations };
}

describe("assistant-text semantic finality through real synthetic adapters", () => {
  for (const harness of ["claude-code", "codex"] as const) {
    it(harness + " accepts an assistant text ending", async () => {
      const records = harness === "claude-code" ? [claudeAssistant([text("FINAL")])] : [codexText("FINAL"), complete()];
      expect((await observe(harness, records)).result).toBe(true);
    });
    it(harness + " invalidates a stale text ending after a tool call", async () => {
      const records = harness === "claude-code" ? [claudeAssistant([text("FINAL")]), claudeAssistant([call])] :
        [codexText("FINAL"), codexCall(), complete()];
      const actual = await observe(harness, records);
      expect(actual.observations.some(observation => observation.kind === "tool_call")).toBe(true);
      expect(actual.result).toBe(false);
    });
    it(harness + " accepts a later assistant text after a tool", async () => {
      const records = harness === "claude-code" ?
        [claudeAssistant([text("STALE")]), claudeAssistant([call]), claudeAssistant([text("FINAL")])] :
        [codexText("STALE"), codexCall(), codexText("FINAL"), complete()];
      expect((await observe(harness, records)).result).toBe(true);
    });
  }
  it("preserves Claude thinking before text on one record", async () => {
    expect((await observe("claude-code", [claudeAssistant([thinking, text("FINAL")])])).result).toBe(true);
  });
  it("invalidates Claude thinking after text on one record", async () => {
    expect((await observe("claude-code", [claudeAssistant([text("FINAL"), thinking])])).result).toBe(false);
  });
  it("preserves legacy Claude hook-summary bookkeeping", async () => {
    const actual = await observe("claude-code", [claudeAssistant([text("FINAL")]),
      { type: "system", subtype: "stop_hook_summary" }, { type: "last-prompt", lastPrompt: "fixture" }]);
    expect(actual.result).toBe(true);
  });
  it("invalidates Codex future unknown envelopes after text", async () => {
    const actual = await observe("codex", [codexText("FINAL"), complete(), envelope("future_envelope", { value: 1 })]);
    expect(actual.observations.some(observation => observation.kind === "unknown" && observation.nativeKind === "future_envelope")).toBe(true);
    expect(actual.result).toBe(false);
  });
  it("does not let delayed Codex fallback resurrect text before a later tool", async () => {
    const actual = await observe("codex", [
      envelope("event_msg", { type: "agent_message", message: "STALE" }), codexCall(), complete(),
    ]);
    const fallback = actual.observations.findIndex(observation => observation.kind === "message" && observation.representation === "projection-fallback");
    const tool = actual.observations.findIndex(observation => observation.kind === "tool_call");
    expect(tool).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(tool);
    const fallbackObservation = actual.observations[fallback];
    const toolObservation = actual.observations[tool];
    expect(fallbackObservation?.evidence.line.byteOffset).toBeLessThan(toolObservation?.evidence.line.byteOffset ?? -1);
    expect(actual.result).toBe(false);
  });
  it("accepts a delayed Codex fallback after the tool's physical record", async () => {
    const actual = await observe("codex", [
      codexCall(), envelope("event_msg", { type: "agent_message", message: "FINAL" }), complete(),
    ]);
    expect(actual.observations.some(observation => observation.kind === "message" && observation.representation === "projection-fallback")).toBe(true);
    expect(actual.result).toBe(true);
  });
  it("invalidates an aborted Codex turn after text", async () => {
    const actual = await observe("codex", [codexText("FINAL"),
      envelope("event_msg", { type: "turn_aborted", turn_id: "turn" })]);
    expect(actual.observations.some(observation => observation.kind === "native_turn" && observation.phase === "aborted")).toBe(true);
    expect(actual.result).toBe(false);
  });
  it("keeps a new Codex turn from reusing a preceding text ending", async () => {
    expect((await observe("codex", [codexText("STALE"), complete(), start()])).result).toBe(false);
  });
});
