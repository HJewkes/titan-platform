import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIGNAL_COPY_RANK } from "./audit-schema.js";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { purgeTranscript } from "./purge.js";
import { refreshCorpus } from "./refresh.js";

const SESSION = "s-mirrored";
const line = (fields: Record<string, unknown>) => ({ sessionId: SESSION, cwd: "/scratch", gitBranch: "main", ...fields });
const prompt = (ts: string) => line({ type: "user", uuid: `u-${ts}`, timestamp: ts, message: { role: "user", content: "go" } });
const assistant = (ts: string, requestId: string, content: unknown[] = [{ type: "text", text: "ok" }]) =>
  line({
    type: "assistant",
    timestamp: ts,
    requestId,
    message: { id: `msg-${requestId}`, role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content },
  });
const bash = (id: string, command: string) => [{ type: "tool_use", id, name: "Bash", input: { command } }];
const render = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

// Both hosts hold the same opening, then each carries on alone: neither file is a prefix of the other.
const SHARED = [
  prompt("2026-10-01T00:00:00Z"),
  assistant("2026-10-01T00:00:01Z", "req-1", bash("tu-commit", "git commit -m x && git push")),
];
const BASEMENT_TAIL = [prompt("2026-10-01T01:00:00Z"), assistant("2026-10-01T01:00:01Z", "req-b")];
const MAC_TAIL = [
  prompt("2026-10-01T02:00:00Z"),
  assistant("2026-10-01T02:00:01Z", "req-m1"),
  assistant("2026-10-01T02:00:02Z", "req-m2", [{ type: "text", text: "the mac copy is longer" }]),
];

let dir: string;
let graph: SessionGraph;

function transcriptAt(relative: string, lines: unknown[], account: string, host?: string): DiscoveredTranscript {
  const absolutePath = path.join(dir, relative, `${SESSION}.jsonl`);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, render(lines));
  return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account, ...(host ? { host } : {}) };
}

const basement = () => transcriptAt("claude-profiles/server/projects/p", [...SHARED, ...BASEMENT_TAIL], "server");
const mac = () => transcriptAt("mac-transcripts/server/projects/p", [...SHARED, ...MAC_TAIL], "server", "mac");

const column = (row: unknown, key: string): unknown => (typeof row === "object" && row !== null ? Object.getOwnPropertyDescriptor(row, key)?.value : undefined);
const numberAt = (row: unknown, key: string): number => {
  const value = column(row, key);
  if (typeof value !== "number") throw new Error(`expected a number in column ${key}`);
  return value;
};
const stringAt = (row: unknown, key: string): string => {
  const value = column(row, key);
  if (typeof value !== "string") throw new Error(`expected a string in column ${key}`);
  return value;
};
const scalar = (sql: string, ...params: unknown[]): number => numberAt(graph.db.prepare(sql).get(...params), "n");
const ownerId = () => numberAt(graph.db.prepare("SELECT transcript_id AS id FROM session").get(), "id");
const promptIds = () =>
  graph.db
    .prepare("SELECT prompt_id FROM turn ORDER BY prompt_id")
    .all()
    .map((r) => stringAt(r, "prompt_id"));
const danglingTurns = () => scalar("SELECT COUNT(*) AS n FROM turn WHERE fact_id_start NOT IN (SELECT fact_id FROM fact)");

const sessionRow = () =>
  graph.db
    .prepare("SELECT session_id, turn_count, commit_count, push_count FROM session")
    .all()
    .map((r) => ({
      session_id: stringAt(r, "session_id"),
      turn_count: numberAt(r, "turn_count"),
      commit_count: numberAt(r, "commit_count"),
      push_count: numberAt(r, "push_count"),
    }));

const firstCopySignals = () =>
  graph.db
    .prepare(`SELECT signal FROM (SELECT signal, ${SIGNAL_COPY_RANK} AS copy_rank FROM session_signal WHERE session_id = ?) WHERE copy_rank = 1 ORDER BY signal`)
    .all(SESSION)
    .map((r) => stringAt(r, "signal"));

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-mirror-"));
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("one session in a basement tree and a mac mirror", () => {
  it("is one session row with both transcripts as children", async () => {
    await refreshCorpus(graph, [basement(), mac()]);

    expect(sessionRow().map((r) => r.session_id)).toEqual([SESSION]);
    expect(scalar("SELECT COUNT(DISTINCT transcript_id) AS n FROM fact WHERE session_id = ?", SESSION)).toBe(2);
  });

  it("counts the shared commit, push and assistant lines once", async () => {
    await refreshCorpus(graph, [basement(), mac()]);

    // Assistant lines: one shared, one basement-only, two mac-only.
    expect(sessionRow()[0]).toMatchObject({ turn_count: 4, commit_count: 1, push_count: 1 });
    expect(scalar("SELECT COUNT(*) AS n FROM session_signal WHERE signal = 'commit'")).toBe(2);
    expect(firstCopySignals()).toEqual(["command_heads", "commit", "push"]);
  });

  it("matches the counts of a single file holding every line", async () => {
    const whole = transcriptAt("whole/projects/p", [...SHARED, ...BASEMENT_TAIL, ...MAC_TAIL], "server");
    await refreshCorpus(graph, [whole]);
    const single = sessionRow()[0];

    const mirrored = openSessionGraph(":memory:");
    try {
      await refreshCorpus(mirrored, [basement(), mac()]);
      const row = mirrored.db.prepare("SELECT turn_count, commit_count, push_count FROM session").get();
      expect(row).toEqual({ turn_count: single!.turn_count, commit_count: single!.commit_count, push_count: single!.push_count });
    } finally {
      mirrored.db.close();
    }
  });

  it("keeps the session when one copy is purged for a re-read", async () => {
    const copies = [basement(), mac()];
    await refreshCorpus(graph, copies);
    const owner = ownerId();

    purgeTranscript(graph, owner);

    expect(sessionRow().map((r) => r.session_id)).toEqual([SESSION]);
    expect(scalar("SELECT COUNT(*) AS n FROM turn WHERE session_id = ?", SESSION)).toBeGreaterThan(0);
    expect(ownerId()).not.toBe(owner);
  });

  it("re-reads a shortened copy without phantom turns or dangling fact ids", async () => {
    await refreshCorpus(graph, [basement(), mac()]);
    const shortened = transcriptAt("claude-profiles/server/projects/p", SHARED, "server");
    const owner = ownerId();

    purgeTranscript(graph, owner);
    await refreshCorpus(graph, [shortened, mac()]);

    const prompts = promptIds();
    expect(prompts).toEqual(["u-2026-10-01T00:00:00Z", "u-2026-10-01T02:00:00Z"]);
    expect(danglingTurns()).toBe(0);
  });

  it("keeps a shared turn the other copy holds when the re-read copy drops it", async () => {
    await refreshCorpus(graph, [basement(), mac()]);
    const rewritten = transcriptAt("claude-profiles/server/projects/p", BASEMENT_TAIL, "server");

    await refreshCorpus(graph, [rewritten, mac()]);

    const prompts = promptIds();
    expect(prompts).toEqual(["u-2026-10-01T00:00:00Z", "u-2026-10-01T01:00:00Z", "u-2026-10-01T02:00:00Z"]);
    expect(danglingTurns()).toBe(0);
  });

  it("recounts a session left in one copy to that copy's counts", async () => {
    await refreshCorpus(graph, [basement(), mac()]);
    const emptied = transcriptAt("claude-profiles/server/projects/p", [], "server");

    await refreshCorpus(graph, [emptied, mac()]);

    const alone = openSessionGraph(":memory:");
    try {
      await refreshCorpus(alone, [mac()]);
      const expected = alone.db.prepare("SELECT turn_count, commit_count, push_count FROM session").get();
      expect(graph.db.prepare("SELECT turn_count, commit_count, push_count FROM session").get()).toEqual(expected);
    } finally {
      alone.db.close();
    }
  });

  it("drops only the purged copy's search spans", async () => {
    await refreshCorpus(graph, [basement(), mac()]);
    const owner = ownerId();

    purgeTranscript(graph, owner);

    const sources = graph.db
      .prepare("SELECT DISTINCT source_id AS id FROM search_span")
      .all()
      .map((r) => numberAt(r, "id"));
    expect(sources.length).toBe(1);
    expect(sources[0]).not.toBe(owner);
  });

  it("still counts a session read from one transcript as before", async () => {
    await refreshCorpus(graph, [basement()]);

    expect(sessionRow()[0]).toMatchObject({ turn_count: 2, commit_count: 1, push_count: 1 });
  });
});
