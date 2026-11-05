import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { refreshCorpus } from "./refresh.js";
import { rollupYielding } from "./rollup.js";

const SESSIONS = ["sess-a", "sess-b", "sess-c"];

let dir: string;
let graph: SessionGraph;

function transcript(sessionId: string): DiscoveredTranscript {
  const absolutePath = path.join(dir, `${sessionId}.jsonl`);
  const prompt = { type: "user", sessionId, uuid: `u-${sessionId}`, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "go" } };
  writeFileSync(absolutePath, JSON.stringify(prompt) + "\n");
  return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
}

/** Indexed sessions whose turns read as a pass killed before its rollup left them. */
async function unfinishedSessions(): Promise<void> {
  await refreshCorpus(graph, SESSIONS.map(transcript));
  graph.db.prepare("UPDATE turn SET ended_at = NULL").run();
}

const unfinishedTurns = (): number => graph.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM turn WHERE ended_at IS NULL").get()?.n ?? 0;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-rollup-yield-"));
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("rollupYielding", () => {
  it("rolls up each session once, yielding after each", async () => {
    await unfinishedSessions();
    const unfinishedAtYield: number[] = [];

    const updated = await rollupYielding(graph, [...SESSIONS, "sess-a"], async () => void unfinishedAtYield.push(unfinishedTurns()));

    expect(updated).toBe(SESSIONS.length);
    expect(unfinishedAtYield).toEqual([2, 1, 0]);
  });

  it("still rolls up the sessions after an abort at a yield point", async () => {
    await unfinishedSessions();
    const abort = new Error("shutting down");

    await expect(rollupYielding(graph, SESSIONS, () => Promise.reject(abort))).rejects.toBe(abort);

    expect(unfinishedTurns()).toBe(0);
  });
});
