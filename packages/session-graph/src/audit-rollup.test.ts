import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, resetIndex, type SessionGraph } from "./graph.js";
import { refreshCorpus } from "./refresh.js";

const QUEUED = "also check the docs";

const base = (sessionId: string, ts: string, fields: Record<string, unknown>) => ({ sessionId, cwd: "/scratch", gitBranch: "main", timestamp: ts, ...fields });
const prompt = (id: string, ts: string) => base("s1", ts, { type: "user", uuid: id, promptId: id, message: { role: "user", content: "do the thing" } });
const assistant = (sessionId: string, ts: string, requestId: string, usage: { cacheRead: number; output: number }, content: unknown[] = [{ type: "text", text: "ok" }]) =>
  base(sessionId, ts, {
    type: "assistant",
    requestId,
    message: { id: `msg-${requestId}`, role: "assistant", model: "claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: 5, output_tokens: usage.output }, content },
  });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => [{ type: "tool_use", id, name, input }];
const toolResult = (ts: string, toolUseId: string, toolUseResult: Record<string, unknown>) =>
  base("s1", ts, { type: "user", toolUseResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "out" }] } });
const ASK_INPUT = { questions: [{ question: "Which one?", options: [{ label: "A" }, { label: "B" }] }] };

/** One session touching every rollup input: a tool loop, an AskUserQuestion answer, a mid-loop queued message, two compactions. */
const LINES = [
  prompt("p1", "2026-09-01T00:00:00Z"),
  assistant("s1", "2026-09-01T00:00:01Z", "req-1", { cacheRead: 100, output: 4 }, toolUse("tu-bash", "Bash", { command: "ls" })),
  toolResult("2026-09-01T00:00:02Z", "tu-bash", { stdout: "out", stderr: "" }),
  base("s1", "2026-09-01T00:00:03Z", { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 1000 } }),
  assistant("s1", "2026-09-01T00:00:05Z", "req-2", { cacheRead: 285, output: 6 }, toolUse("tu-ask", "AskUserQuestion", ASK_INPUT)),
  assistant("s1", "2026-09-01T00:00:05Z", "req-2", { cacheRead: 285, output: 6 }, [{ type: "text", text: "asking" }]),
  toolResult("2026-09-01T00:00:06Z", "tu-ask", { ...ASK_INPUT, answers: { "Which one?": "A" }, annotations: {} }),
  assistant("s1", "2026-09-01T00:00:07Z", "req-3", { cacheRead: 300, output: 8 }, toolUse("tu-read", "Read", { file_path: "/scratch/a" })),
  base("s1", "2026-09-01T00:00:08Z", { type: "queue-operation", operation: "enqueue", content: QUEUED }),
  base("s1", "2026-09-01T00:00:10Z", { type: "attachment", attachment: { type: "queued_command", prompt: QUEUED } }),
  assistant("s1", "2026-09-01T00:00:11Z", "req-4", { cacheRead: 320, output: 2 }),
  base("s1", "2026-09-01T00:00:12Z", { type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 900 } }),
];

/** A session whose first request has no arrival before it. */
const HEADLESS = [
  assistant("s2", "2026-09-02T00:00:00Z", "req-h1", { cacheRead: 50, output: 3 }),
  base("s2", "2026-09-02T00:00:01Z", { type: "user", uuid: "p2", promptId: "p2", message: { role: "user", content: "next" } }),
  assistant("s2", "2026-09-02T00:00:02Z", "req-h2", { cacheRead: 60, output: 3 }),
];

const render = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-audit-rollup-"));
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[]): DiscoveredTranscript {
  const absolutePath = path.join(dir, `${name}.jsonl`);
  writeFileSync(absolutePath, render(lines));
  return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
}

const all = (sql: string, ...params: unknown[]) => graph.db.prepare(sql).all(...params) as Record<string, unknown>[];
const request = (requestId: string) => graph.db.prepare("SELECT * FROM request WHERE request_id = ?").get(requestId) as Record<string, unknown>;
const lineOffset = (index: number, lines: unknown[] = LINES) => Buffer.byteLength(render(lines.slice(0, index)));

async function indexMain(): Promise<void> {
  await refreshCorpus(graph, [writeTranscript("s1", LINES)]);
}

describe("audit rollup", () => {
  it("gap_ms and seq_in_session follow request order within a session", async () => {
    await indexMain();
    expect(all("SELECT request_id, seq_in_session, gap_ms FROM request WHERE session_id = 's1' ORDER BY seq_in_session")).toEqual([
      { request_id: "req-1", seq_in_session: 0, gap_ms: null },
      { request_id: "req-2", seq_in_session: 1, gap_ms: 4000 },
      { request_id: "req-3", seq_in_session: 2, gap_ms: 2000 },
      { request_id: "req-4", seq_in_session: 3, gap_ms: 4000 },
    ]);
  });

  it("ctx_delta is context minus previous context plus previous output", async () => {
    await indexMain();
    // context_tokens = 10 input + cache_read + 5 cache_creation: 115, 300, 315, 335.
    expect(all("SELECT request_id, ctx_delta FROM request WHERE session_id = 's1' ORDER BY seq_in_session")).toEqual([
      { request_id: "req-1", ctx_delta: null },
      { request_id: "req-2", ctx_delta: 300 - (115 + 4) },
      { request_id: "req-3", ctx_delta: 315 - (300 + 6) },
      { request_id: "req-4", ctx_delta: 335 - (315 + 8) },
    ]);
  });

  it("a request after a Bash tool result has wake_cause tool_result, wake_detail Bash, wake_tool_family bash", async () => {
    await indexMain();
    expect(request("req-2")).toMatchObject({
      wake_cause: "tool_result",
      wake_delivery: "tool_result",
      wake_detail: "Bash",
      wake_tool_family: "bash",
      wake_mcp_server: null,
      wake_offset: lineOffset(2),
    });
  });

  it("a request after an AskUserQuestion result has wake_cause ask_user_answer", async () => {
    await indexMain();
    expect(request("req-3")).toMatchObject({ wake_cause: "ask_user_answer", wake_detail: "AskUserQuestion", wake_offset: lineOffset(6) });
  });

  it("a request after a queued_command keeps wake_delivery mid_loop", async () => {
    await indexMain();
    expect(request("req-4")).toMatchObject({ wake_delivery: "mid_loop", wake_offset: lineOffset(9) });
  });

  it("the first request of a session is session_start", async () => {
    // s1's arrivals precede s2 in the same file; they must not wake s2's first request.
    const both = [...LINES, ...HEADLESS];
    await refreshCorpus(graph, [writeTranscript("both", both)]);
    expect(request("req-h1")).toMatchObject({ wake_cause: "session_start", wake_delivery: null, wake_offset: null });
    expect(request("req-h2")).toMatchObject({ wake_cause: "human_typed", wake_delivery: "turn_start", wake_offset: lineOffset(LINES.length + 1, both) });
  });

  it("queued_ms pairs an enqueue with its delivery by content hash", async () => {
    await indexMain();
    expect(all("SELECT byte_offset, delivery, queued_ms FROM inbound WHERE queued_ms IS NOT NULL")).toEqual([
      { byte_offset: lineOffset(9), delivery: "mid_loop", queued_ms: 2000 },
    ]);
  });

  it("compaction.mid_loop is set when the previous inbound was a tool result", async () => {
    await indexMain();
    expect(all("SELECT byte_offset, mid_loop FROM compaction ORDER BY byte_offset")).toEqual([
      { byte_offset: lineOffset(3), mid_loop: 1 },
      { byte_offset: lineOffset(11), mid_loop: 0 },
    ]);
  });

  it("turn.wake_cause is filled", async () => {
    await indexMain();
    await refreshCorpus(graph, [writeTranscript("s2", HEADLESS)]);
    expect(all("SELECT prompt_id, wake_cause FROM turn ORDER BY prompt_id")).toEqual([
      { prompt_id: "p1", wake_cause: "human_typed" },
      { prompt_id: "p2", wake_cause: "human_typed" },
    ]);
  });

  it("session_model_usage equals the request table's sums", async () => {
    await indexMain();
    await refreshCorpus(graph, [writeTranscript("s2", HEADLESS)]);
    const sums = all(`
      SELECT session_id, model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(thinking_tokens) AS thinking_tokens, COUNT(*) AS request_count
      FROM request GROUP BY session_id, model ORDER BY session_id`);
    expect(all("SELECT * FROM session_model_usage ORDER BY session_id")).toEqual(sums);
    // req-2 is written as two lines; line-level accumulation would have counted it twice.
    expect(sums[0]).toMatchObject({ session_id: "s1", request_count: 4, output_tokens: 4 + 6 + 8 + 2 });
  });

  it("chunked passes equal a full rebuild for every rollup column", async () => {
    const rebuilt = await rollupAfterFullRebuild();
    for (let split = 1; split < LINES.length; split++) {
      graph.db.close();
      graph = openSessionGraph(":memory:");
      const transcript = writeTranscript(`chunked-${split}`, LINES.slice(0, split));
      await refreshCorpus(graph, [transcript]);
      appendFileSync(transcript.absolutePath, render(LINES.slice(split)));
      await refreshCorpus(graph, [transcript]);
      expect(rollupColumns(), `split at line ${split}`).toEqual(rebuilt);
    }
  });
});

async function rollupAfterFullRebuild(): Promise<Record<string, unknown[]>> {
  const transcript = writeTranscript("whole", LINES);
  await refreshCorpus(graph, [transcript]);
  resetIndex(graph);
  await refreshCorpus(graph, [transcript], { full: true });
  const columns = rollupColumns();
  // A convergence check over empty columns proves nothing.
  expect(columns.request!.every((row) => (row as { wake_cause: unknown }).wake_cause !== null)).toBe(true);
  expect(columns.inbound!.some((row) => (row as { queued_ms: unknown }).queued_ms !== null)).toBe(true);
  return columns;
}

function rollupColumns(): Record<string, unknown[]> {
  return {
    request: all(`SELECT request_id, byte_offset, seq_in_session, gap_ms, ctx_delta, wake_cause, wake_delivery, wake_detail,
      wake_tool_family, wake_mcp_server, wake_offset FROM request ORDER BY request_id`),
    inbound: all("SELECT byte_offset, block_index, queued_ms FROM inbound ORDER BY byte_offset, block_index"),
    compaction: all("SELECT byte_offset, mid_loop FROM compaction ORDER BY byte_offset"),
    turn: all("SELECT prompt_id, wake_cause FROM turn ORDER BY prompt_id"),
    usage: all("SELECT * FROM session_model_usage ORDER BY session_id, model"),
  };
}
