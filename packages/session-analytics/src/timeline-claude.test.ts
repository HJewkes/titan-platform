import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSourceFromPath, readSessionObservations } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costReport } from "./cost-report.js";
import { createFixtureGraph, insertPrices, insertRequest, insertSession, type RequestFixture } from "./fixture.js";
import { SessionTimelineAccumulator } from "./timeline.js";
import type { SessionTimeline } from "./timeline-types.js";

const SESSION = "session-decoded";
const USAGE = { input_tokens: 10, cache_read_input_tokens: 70, cache_creation_input_tokens: 20, output_tokens: 5 };
const SPLIT_USAGE = { ...USAGE, cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 } };
const REQUEST_TS = "2026-03-02T00:00:00Z";

/** The opening words are the harness's fixed compaction marker; the summary after the blank line is invented. */
const SUMMARY_LINE = "This session is being continued from a previous conversation that ran out of context.\n\nThe files were listed once.";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: SESSION, ...fields });
}

function assistant(uuid: string, ts: string, content: unknown[], extra: Record<string, unknown> = {}, usage: object = USAGE): string {
  return line({ type: "assistant", uuid, timestamp: ts, ...extra, message: { role: "assistant", id: "msg-1", model: "claude-opus-5", usage, content } });
}

/** Invented lines in Claude Code's transcript format, one response written over two lines. */
const LINES = [
  line({ type: "user", uuid: "u1", timestamp: "2026-03-01T23:59:50Z", message: { role: "user", content: "list the files" } }),
  assistant("a1", "2026-03-01T23:59:55Z", [{ type: "text", text: "Listing them." }]),
  assistant("a2", "2026-03-02T00:00:02Z", [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } }]),
  line({
    type: "user",
    uuid: "u2",
    timestamp: "2026-03-02T00:00:04Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true, content: "ls: no such directory" }] },
  }),
  line({ type: "system", uuid: "s1", subtype: "compact_boundary", timestamp: "2026-03-02T00:00:06Z" }),
  line({ type: "user", uuid: "u3", timestamp: "2026-03-02T00:00:07Z", message: { role: "user", content: SUMMARY_LINE } }),
  assistant("a3", "2026-03-02T00:00:08Z", [{ type: "tool_use", id: "call-2", name: "Read", input: { file_path: "/repo/notes.md" } }], { isSidechain: true }),
];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-timeline-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function timelineOf(lines: readonly string[]): Promise<SessionTimeline> {
  const file = path.join(dir, `${SESSION}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  const accumulator = new SessionTimelineAccumulator();
  for await (const observation of readSessionObservations(claudeSourceFromPath(file, "fixture-host"))) accumulator.add(observation);
  return accumulator.result();
}

function costReportUsd(request: Omit<RequestFixture, "sessionId" | "ts">): number {
  const fixture = createFixtureGraph();
  try {
    insertPrices(fixture.graph);
    insertSession(fixture.graph.db, { sessionId: SESSION });
    insertRequest(fixture.graph.db, { sessionId: SESSION, ts: REQUEST_TS, ...request });
    return costReport(fixture.openReadOnly(), { since: "2026-03-01", until: "2026-03-03" }).totals.costUsd;
  } finally {
    fixture.close();
  }
}

describe("a timeline built from the Claude transcript decoder", () => {
  it("folds a streamed read of a real-format file", async () => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    writeFileSync(file, `${LINES.join("\n")}\n`, "utf8");
    const accumulator = new SessionTimelineAccumulator();

    for await (const observation of readSessionObservations(claudeSourceFromPath(file, "fixture-host"))) accumulator.add(observation);
    const timeline = accumulator.result();

    expect(timeline).toMatchObject({ sessionId: SESSION, harness: "claude-code", durationMs: 18_000 });
    expect(timeline.turns.map((turn) => [turn.origin, turn.errorCount])).toEqual([
      ["prompt", 1],
      ["compaction", 0],
    ]);
    expect(timeline.turns.flatMap((turn) => turn.toolCalls).map((call) => [call.id, call.turnIndex, call.outcome, call.sidechain])).toEqual([
      ["call-1", 0, "error", false],
      ["call-2", 1, "pending", true],
    ]);
    expect(timeline.errors.items[0]?.message).toBe("ls: no such directory");
    expect(timeline.buckets.map((bucket) => bucket.events)).toEqual([2, 4]);
  });

  it("counts a compaction once though the transcript writes a boundary line and a summary line", async () => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    writeFileSync(file, `${LINES.join("\n")}\n`, "utf8");
    const accumulator = new SessionTimelineAccumulator();

    for await (const observation of readSessionObservations(claudeSourceFromPath(file, "fixture-host"))) accumulator.add(observation);
    const timeline = accumulator.result();

    expect(timeline.totals.compactions).toBe(1);
    expect(timeline.tokens.compactions).toEqual([
      expect.objectContaining({ atMs: Date.parse("2026-03-02T00:00:06Z"), turnIndex: 0, summary: "The files were listed once.", summaryTruncated: false }),
    ]);
  });

  it("counts the repeated usage of one response once and splits its prompt tokens", async () => {
    const file = path.join(dir, `${SESSION}.jsonl`);
    writeFileSync(file, `${LINES.join("\n")}\n`, "utf8");
    const accumulator = new SessionTimelineAccumulator();

    for await (const observation of readSessionObservations(claudeSourceFromPath(file, "fixture-host"))) accumulator.add(observation);
    const { totals, tokens } = accumulator.result();

    expect(totals).toMatchObject({ requests: 1, unpricedRequests: 0, tokens: { input: 10, cacheRead: 70, cacheWrite: 20, cacheWrite5m: 20, cacheWrite1h: 0, output: 5 } });
    expect(tokens.points[0]).toMatchObject({ contextTokens: 100, model: "claude-opus-5", priced: true });
    expect(tokens.points[0]?.costUsd).toBeCloseTo((10 * 5 + 70 * 0.5 + 20 * 6.25 + 5 * 25) / 1_000_000);
  });

  it("prices 1h cache writes at the 1h rate when the usage carries the ttl split", async () => {
    const timeline = await timelineOf([assistant("a1", REQUEST_TS, [{ type: "text", text: "Cached." }], {}, SPLIT_USAGE)]);

    expect(timeline.totals.tokens).toMatchObject({ cacheWrite: 20, cacheWrite5m: 5, cacheWrite1h: 15 });
    expect(timeline.totals.costUsd).toBeCloseTo((10 * 5 + 70 * 0.5 + 5 * 6.25 + 15 * 10 + 5 * 25) / 1_000_000, 12);
  });

  it.each([
    { name: "a 5m and 1h split", usage: SPLIT_USAGE, request: { cacheCreation5m: 5, cacheCreation1h: 15 } },
    { name: "only the flat total", usage: USAGE, request: { cacheCreationTokens: 20 } },
  ])("agrees with costReport on the price of a request carrying $name", async ({ usage, request }) => {
    const timeline = await timelineOf([assistant("a1", REQUEST_TS, [{ type: "text", text: "Cached." }], {}, usage)]);

    const reported = costReportUsd({ model: "claude-opus-5", inputTokens: 10, cacheReadTokens: 70, outputTokens: 5, ...request });

    expect(timeline.totals.costUsd).toBeCloseTo(reported, 12);
  });
});
