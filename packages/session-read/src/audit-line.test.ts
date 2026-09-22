import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "./events.js";
import { FIXTURE_LINES, QUEUED_CHANNEL_TEXT, SESSION, offsetAfterLine, renderTranscript } from "./fixture.js";
import { LineReader } from "./line-reader.js";
import { extractTranscript } from "./read.js";
import type { Json } from "./text.js";

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-read-audit-"));
  transcript = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(transcript, renderTranscript(FIXTURE_LINES), "utf8");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function eventsFor(lines: Record<string, unknown>[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  const reader = new LineReader((event) => out.push(event));
  let byteOffset = 0;
  for (const line of lines) {
    const byteLength = Buffer.byteLength(JSON.stringify(line), "utf8");
    reader.handle(line as Json, { byteOffset, byteLength });
    byteOffset += byteLength + 1;
  }
  return out;
}

describe("audit emitters", () => {
  it("emits one request event per assistant line and the same requestId on both lines of a two-block response", async () => {
    const result = await extractTranscript(transcript);
    const assistantLines = FIXTURE_LINES.filter((l) => l.type === "assistant");
    expect(result.requests).toHaveLength(assistantLines.length);
    const shared = result.requests.filter((r) => r.requestId === "req_two_block");
    expect(shared.map((r) => r.messageId)).toEqual(["msg-2026-07-01T00:00:05Z", "msg-2026-07-01T00:00:06Z"]);
    expect(shared[0]).toMatchObject({ model: "claude-opus-5", blockIndex: 0, isSidechain: false, serviceTier: null });
  });

  it("falls back to message.id when requestId is absent", async () => {
    const result = await extractTranscript(transcript);
    const fallback = result.requests.find((r) => r.ts === "2026-07-01T00:00:07Z");
    expect(fallback).toMatchObject({ requestId: "msg-2026-07-01T00:00:07Z", messageId: "msg-2026-07-01T00:00:07Z" });
    const line = { type: "assistant", sessionId: SESSION, timestamp: "t", message: { model: "m", usage: { input_tokens: 1 }, content: [] } };
    expect(eventsFor([line]).filter((e) => e.kind === "request")).toHaveLength(0);
  });

  it("splits cache creation into 5m and 1h", async () => {
    const result = await extractTranscript(transcript);
    const shared = result.requests.filter((r) => r.requestId === "req_two_block");
    expect(shared[0]).toMatchObject({ cacheCreationTokens: 2, cacheCreation5mTokens: 1, cacheCreation1hTokens: 1 });
    const plain = result.requests.find((r) => r.ts === "2026-07-01T00:00:07Z");
    expect(plain).toMatchObject({ cacheCreationTokens: 2, cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 });
  });

  it("emits tool_call with family and mcp server per tool_use block, blockIndex set", () => {
    const line = {
      type: "assistant",
      sessionId: SESSION,
      timestamp: "2026-07-01T00:01:00Z",
      message: {
        model: "claude-opus-5",
        id: "msg-tools",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: "text", text: "doing it" },
          { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "c2", name: "mcp__plugin_agent-chat_agent-chat__chat_send", input: { message: "hi" } },
          { type: "tool_use", id: "c3", name: "mcp__other_server__do", input: {} },
        ],
      },
    };
    const calls = eventsFor([line]).filter((e) => e.kind === "tool_call");
    expect(calls.map((c) => [c.toolUseId, c.blockIndex, c.family, c.mcpServer])).toEqual([
      ["c1", 1, "bash", null],
      ["c2", 2, "mcp_agentchat", "plugin_agent-chat_agent-chat"],
      ["c3", 3, "mcp_other", "other_server"],
    ]);
    expect(calls[0]?.inputChars).toBe(JSON.stringify({ command: "ls" }).length);
  });

  it("reads trigger, preTokens, postTokens and durationMs from compact_boundary", async () => {
    const result = await extractTranscript(transcript);
    expect(result.compactions).toEqual([
      expect.objectContaining({ trigger: "manual", preTokens: 596595, postTokens: 13907, droppedTokens: 582688, durationMs: 119243 }),
    ]);
    const bare = eventsFor([{ type: "system", subtype: "compact_boundary", sessionId: SESSION, timestamp: "t" }]);
    expect(bare.filter((e) => e.kind === "compaction")[0]).toMatchObject({ trigger: null, preTokens: null, durationMs: null });
  });

  it("emits queue_op for enqueue, dequeue, remove and popAll", async () => {
    const result = await extractTranscript(transcript);
    expect(result.queueOps.map((q) => q.operation)).toEqual(["enqueue", "remove", "dequeue", "popAll"]);
    const [enqueue, remove, dequeue] = result.queueOps;
    expect(enqueue?.originServer).toBe("plugin:demo:demo");
    expect(enqueue?.contentHash).toBe(remove?.contentHash);
    expect(dequeue?.contentHash).toBeNull();
    expect(QUEUED_CHANNEL_TEXT).toContain("plugin:demo:demo");
    expect(eventsFor([{ type: "queue-operation", operation: "invented", sessionId: SESSION }]).filter((e) => e.kind === "queue_op")).toHaveLength(0);
  });

  it("emits cost_state with totalCostUSD", async () => {
    const result = await extractTranscript(transcript);
    expect(result.costStates).toHaveLength(1);
    expect(result.costStates[0]).toMatchObject({ totalCostUsd: 25.5, blockIndex: 0 });
    expect(JSON.parse(result.costStates[0]!.modelUsageJson)).toHaveProperty("claude-opus-5.costUSD", 25.5);
  });

  it("a chunked read equals a whole-file read for every audit list", async () => {
    const split = offsetAfterLine(FIXTURE_LINES, 8);
    const full = await extractTranscript(transcript);
    const first = await extractTranscript(transcript, { untilByteOffset: split });
    const second = await extractTranscript(transcript, { fromByteOffset: first.lastByteOffset, priorPrefixHash: first.prefixHash });

    const keys = ["requests", "toolCalls", "inbound", "contextBlocks", "compactions", "queueOps", "signals", "costStates"] as const;
    for (const kind of keys) {
      expect([...first[kind], ...second[kind]], kind).toEqual(full[kind]);
    }
  });
});
