import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeObservations } from "./claude-read.js";
import { claudeSourceFromPath } from "./claude-source.js";
import { decodeClaudeToolLines } from "./claude-tool-lines.js";

const call = (id: string, sessionId = "s-1", extra: object = {}) =>
  JSON.stringify({ type: "assistant", sessionId, timestamp: "2026-01-01T00:00:00Z", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] }, ...extra });
const result = (id: string, sessionId = "s-1", isError?: boolean) =>
  JSON.stringify({ type: "user", sessionId, timestamp: "2026-01-01T00:00:01Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: "out", ...(isError === undefined ? {} : { is_error: isError }) }] } });
const decode = (lines: Iterable<string>) => [...decodeClaudeToolLines(lines)];

describe("decodeClaudeToolLines", () => {
  it("skips malformed, non-object, string-literal and blank lines and keeps input positions", () => {
    const lines = [call("c1"), '{"type":"assistant"', '["tool_use"]', '"tool_use"', "", result("c1")];

    const out = decode(lines);

    expect(out.map((l) => [l.kind, l.callId, l.lineIndex])).toEqual([["tool_call", "c1", 0], ["tool_result", "c1", 5]]);
  });

  it("decodes a stream with two session ids without throwing", () => {
    const out = decode([call("c1", "s-1"), result("c1", "s-2")]);

    expect(out.map((l) => l.sessionId)).toEqual(["s-1", "s-2"]);
  });

  it("yields a repeated call id every time it appears", () => {
    const out = decode([call("c1"), call("c1"), result("c1")]);

    expect(out.map((l) => l.kind)).toEqual(["tool_call", "tool_call", "tool_result"]);
  });

  it("decodes typeless records", () => {
    const content = (block: object) => JSON.stringify({ message: { content: [block] } });

    const out = decode([content({ type: "tool_use", id: "c1", name: "Bash", input: {} }), content({ type: "tool_result", tool_use_id: "c1", content: "x" })]);

    expect(out.map((l) => l.kind)).toEqual(["tool_call", "tool_result"]);
  });

  it("decodes a type value with a space after the colon", () => {
    const line = '{"message": {"content": [{"type": "tool_use", "id": "c1", "name": "Bash"}]}}';

    expect(decode([line]).map((l) => l.callId)).toEqual(["c1"]);
  });

  it("skips a tool_result without tool_use_id and a tool_use without id", () => {
    const content = JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash" }, { type: "tool_result", content: "x" }] } });

    expect(decode([content])).toEqual([]);
  });

  it("is lazy: the first record is returned before later lines are read", () => {
    function* lines() {
      yield call("c1");
      throw new Error("read too far");
    }

    expect(decodeClaudeToolLines(lines()).next().value).toMatchObject({ callId: "c1" });
  });

  it("matches ClaudeTranscriptDecoder on a type-tagged transcript", async () => {
    const lines = [
      JSON.stringify({ type: "assistant", sessionId: "s-1", uuid: "u1", timestamp: "2026-01-01T00:00:00Z", message: { id: "m1", content: [
        { type: "text", text: "hi" }, { type: "thinking", thinking: "hm" },
        { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }, { type: "tool_use", id: "c2", name: "Read", input: { path: "/x" } }] } }),
      JSON.stringify({ type: "user", sessionId: "s-1", uuid: "u2", timestamp: "2026-01-01T00:00:01Z", message: { content: [
        { type: "tool_result", tool_use_id: "c1", content: "out" }, { type: "tool_result", tool_use_id: "c2", content: "bad", is_error: true }] } }),
    ];
    const dir = mkdtempSync(path.join(os.tmpdir(), "titan-tool-lines-"));
    try {
      const file = path.join(dir, "s-1.jsonl");
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
      const expected = [];
      for await (const o of readClaudeObservations(claudeSourceFromPath(file, "ns"))) {
        if (o.kind === "tool_call") expected.push(["tool_call", o.call.nativeId, o.name, o.input, null, null, o.timestamp]);
        if (o.kind === "tool_result") expected.push(["tool_result", o.call.nativeId, null, null, o.output, o.isError, o.timestamp]);
      }

      const actual = decode(lines).map((l) => l.kind === "tool_call"
        ? [l.kind, l.callId, l.name, l.input, null, null, l.timestamp]
        : [l.kind, l.callId, null, null, l.output, l.isError, l.timestamp]);

      expect(expected).toHaveLength(4);
      expect(actual).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
