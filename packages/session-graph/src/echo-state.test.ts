import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, resetIndex, type SessionGraph } from "./graph.js";
import { refreshCorpus, type RefreshOptions } from "./refresh.js";

const line = (fields: Record<string, unknown>) => ({ sessionId: "s1", cwd: "/scratch", gitBranch: "main", ...fields });
/** Echo lines as hosts write them: no timestamp, so the reader carries the previous line's. */
const echo = (type: string, fields: Record<string, unknown>) => ({ type, sessionId: "s1", ...fields });
const prompt = (uuid: string, ts: string) => line({ type: "user", uuid, timestamp: ts, message: { role: "user", content: `prompt ${uuid}` } });
const assistant = (ts: string, content: unknown[]) =>
  line({ type: "assistant", timestamp: ts, requestId: `req-${ts}`, message: { id: `msg-${ts}`, role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content } });
const toolUse = (ts: string, id: string) => assistant(ts, [{ type: "tool_use", id, name: "Bash", input: { command: `echo ${id}` } }]);
const toolResult = (ts: string, id: string) => line({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `out ${id}` }] } });
const text = (ts: string, body: string) => assistant(ts, [{ type: "text", text: body }]);
const render = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

/** Every echo kind, with repeats both adjacent and across turns, between prompts and tool results. */
const EVERY_ECHO = [
  line({ type: "ai-title", aiTitle: "First title", timestamp: "2026-10-01T00:00:00Z" }),
  line({ type: "mode", mode: "plan", timestamp: "2026-10-01T00:00:01Z" }),
  line({ type: "permission-mode", permissionMode: "default", timestamp: "2026-10-01T00:00:02Z" }),
  prompt("p1", "2026-10-01T00:00:03Z"),
  toolUse("2026-10-01T00:00:04Z", "t1"),
  toolResult("2026-10-01T00:00:05Z", "t1"),
  echo("custom-title", { customTitle: "Custom" }),
  echo("cost-state", { totalCostUSD: 0.5, modelUsage: {} }),
  text("2026-10-01T00:00:06Z", "first done"),
  echo("ai-title", { aiTitle: "First title" }),
  line({ type: "mode", mode: "plan", timestamp: "2026-10-01T00:00:07Z" }),
  echo("agent-name", { agentName: "worker-1" }),
  echo("last-prompt", { lastPrompt: "prompt p1" }),
  echo("atis-latch", { atis: "latched" }),
  echo("bridge-session", { bridgeSessionId: "bridge-1", lastSequenceNum: 2 }),
  prompt("p2", "2026-10-01T00:00:10Z"),
  toolUse("2026-10-01T00:00:11Z", "t2"),
  toolResult("2026-10-01T00:00:12Z", "t2"),
  echo("cost-state", { totalCostUSD: 0.5, modelUsage: {} }),
  echo("cost-state", { totalCostUSD: 0.75, modelUsage: {} }),
  line({ type: "mode", mode: "default", timestamp: "2026-10-01T00:00:13Z" }),
  echo("custom-title", { customTitle: "Custom" }),
  echo("agent-name", { agentName: "worker-1" }),
  echo("ai-title", { aiTitle: "Second title" }),
  text("2026-10-01T00:00:14Z", "second done"),
];

const OPTIONS: RefreshOptions = { indexToolSpans: true, contextBlocks: true };

let dir: string;
let graph: SessionGraph;
let transcript: DiscoveredTranscript;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-echo-"));
  const absolutePath = path.join(dir, "s1.jsonl");
  transcript = { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = (sql: string) => graph.db.prepare<[], Record<string, unknown>>(sql).all();
const stripClock = (row: Record<string, unknown>) => {
  const rest = { ...row };
  delete rest.t_indexed;
  delete rest.t_created;
  return rest;
};
const dumpOf = (tables: readonly string[]) => tables.map((t) => `${t}:${JSON.stringify(rows(`SELECT * FROM "${t}" ORDER BY 1, 2, 3`).map(stripClock))}`);
const DUMPED = ["fact", "search_span", "echo_state", "turn", "permission_phase", "edge"] as const;
const echoFacts = () => rows("SELECT event_type, ts FROM fact WHERE event_type IN ('ai_title', 'custom-title', 'agent-name', 'mode', 'permission_mode', 'cost-state') ORDER BY seq");

async function indexWhole(lines: unknown[]): Promise<void> {
  writeFileSync(transcript.absolutePath, render(lines));
  await refreshCorpus(graph, [transcript], OPTIONS);
}

describe("echo state (TP-880)", () => {
  it("stores one fact per value change and remembers the last value", async () => {
    await indexWhole(EVERY_ECHO);

    expect(echoFacts()).toEqual([
      { event_type: "ai_title", ts: "2026-10-01T00:00:00Z" },
      { event_type: "mode", ts: "2026-10-01T00:00:01Z" },
      { event_type: "permission_mode", ts: "2026-10-01T00:00:02Z" },
      { event_type: "custom-title", ts: "2026-10-01T00:00:05Z" },
      { event_type: "cost-state", ts: "2026-10-01T00:00:05Z" },
      { event_type: "agent-name", ts: "2026-10-01T00:00:07Z" },
      { event_type: "cost-state", ts: "2026-10-01T00:00:12Z" },
      { event_type: "mode", ts: "2026-10-01T00:00:13Z" },
      { event_type: "ai_title", ts: "2026-10-01T00:00:13Z" },
    ]);
    expect(rows("SELECT event_type FROM fact WHERE event_type IN ('last_prompt', 'atis-latch', 'bridge-session')")).toEqual([]);
  });

  it("skips a repeated mode in the next chunk and links every phase to its fact", async () => {
    const plan = (ts: string) => line({ type: "mode", mode: "plan", timestamp: ts });
    await indexWhole([plan("2026-10-01T00:00:00Z")]);
    appendFileSync(transcript.absolutePath, render([plan("2026-10-01T00:00:01Z"), line({ type: "mode", mode: "default", timestamp: "2026-10-01T00:00:02Z" })]));
    await refreshCorpus(graph, [transcript], OPTIONS);

    expect(rows("SELECT ts FROM fact WHERE event_type = 'mode' ORDER BY seq")).toEqual([{ ts: "2026-10-01T00:00:00Z" }, { ts: "2026-10-01T00:00:02Z" }]);
    expect(rows("SELECT session_id, key, value FROM echo_state")).toEqual([{ session_id: "s1", key: "mode", value: "default" }]);
    expect(rows("SELECT to_mode FROM permission_phase WHERE fact_id IS NULL")).toEqual([]);
    expect(rows("SELECT count(*) AS n FROM permission_phase")).toEqual([{ n: 2 }]);
  });

  it("an incremental replay at every line boundary equals a full build", async () => {
    await indexWhole(EVERY_ECHO);
    const whole = dumpOf(DUMPED);

    graph.db.close();
    graph = openSessionGraph(":memory:");
    writeFileSync(transcript.absolutePath, "");
    for (const next of EVERY_ECHO) {
      appendFileSync(transcript.absolutePath, render([next]));
      await refreshCorpus(graph, [transcript], OPTIONS);
    }

    expect(dumpOf(DUMPED)).toEqual(whole);
  });

  it("a reset and full re-index stores the same echo facts as the first build", async () => {
    await indexWhole(EVERY_ECHO);
    const first = echoFacts();

    resetIndex(graph);
    await refreshCorpus(graph, [transcript], { ...OPTIONS, full: true });

    expect(echoFacts()).toEqual(first);
  });

  it("a rewritten transcript stores its first ai_title fact again", async () => {
    await indexWhole([line({ type: "ai-title", aiTitle: "Same title", timestamp: "2026-10-01T00:00:00Z" }), prompt("p1", "2026-10-01T00:00:01Z")]);
    writeFileSync(transcript.absolutePath, render([line({ type: "ai-title", aiTitle: "Same title", timestamp: "2026-10-01T00:00:00Z" })]));

    expect(await refreshCorpus(graph, [transcript], OPTIONS)).toMatchObject({ rewound: 1 });
    expect(rows("SELECT event_type FROM fact")).toEqual([{ event_type: "ai_title" }]);
  });

  it("counts thinking time from a tool result past a repeated echo to the next assistant line", async () => {
    await indexWhole([
      echo("custom-title", { customTitle: "Custom" }),
      prompt("p1", "2026-10-01T00:00:01Z"),
      toolUse("2026-10-01T00:00:02Z", "t1"),
      toolResult("2026-10-01T00:00:05Z", "t1"),
      echo("custom-title", { customTitle: "Custom" }),
      text("2026-10-01T00:00:09Z", "done"),
    ]);

    expect(rows("SELECT thinking_ms FROM turn")).toEqual([{ thinking_ms: 1000 + 4000 }]);
  });
});
