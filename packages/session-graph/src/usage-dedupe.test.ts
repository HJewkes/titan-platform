import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { refreshCorpus } from "./refresh.js";

const base = (fields: Record<string, unknown>) => ({ sessionId: "s1", cwd: "/scratch", gitBranch: "main", ...fields });
const prompt = (uuid: string, ts: string, text: string) => base({ type: "user", uuid, timestamp: ts, message: { role: "user", content: text } });
const assistantSplit = (ts: string, content: unknown[]) =>
  base({
    type: "assistant",
    timestamp: ts,
    requestId: "req_1",
    message: { id: "msg_1", role: "assistant", model: "m", usage: { input_tokens: 5, output_tokens: 7 }, content },
  });

// One API response, split across three assistant lines the way a tool-call
// turn is written to the transcript: text, then tool_use, then a trailing line.
const LINES = [
  prompt("p1", "2026-07-01T00:00:00Z", "do the thing"),
  assistantSplit("2026-07-01T00:00:01Z", [{ type: "text", text: "on it" }]),
  assistantSplit("2026-07-01T00:00:02Z", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }]),
  assistantSplit("2026-07-01T00:00:03Z", [{ type: "text", text: "done" }]),
];

const render = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

let dir: string;
let graph: SessionGraph;
let transcript: DiscoveredTranscript;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-usage-dedupe-"));
  const absolutePath = path.join(dir, "s1.jsonl");
  writeFileSync(absolutePath, render(LINES));
  transcript = { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("usage dedupe", () => {
  // Bug tracked as T9 / TP-266: recordUsage in assistant-line.ts has no
  // requestId/message.id dedup, so one API response split across N assistant
  // lines is counted N times. Fix lands with T9; until then this stays it.fails.
  it.fails("counts one request for an API response written as three assistant lines", async () => {
    await refreshCorpus(graph, [transcript]);
    const usage = graph.db.prepare("SELECT request_count, output_tokens FROM session_model_usage").get() as {
      request_count: number;
      output_tokens: number;
    };
    expect(usage.request_count).toBe(1);
    expect(usage.output_tokens).toBe(7);
  });
});
