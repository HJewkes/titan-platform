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

const sessionRow = () =>
  graph.db.prepare("SELECT session_id, turn_count, commit_count, push_count FROM session").all() as {
    session_id: string;
    turn_count: number;
    commit_count: number;
    push_count: number;
  }[];

const firstCopySignals = () =>
  graph.db
    .prepare(`SELECT signal FROM (SELECT signal, ${SIGNAL_COPY_RANK} AS copy_rank FROM session_signal WHERE session_id = ?) WHERE copy_rank = 1 ORDER BY signal`)
    .all(SESSION)
    .map((r) => (r as { signal: string }).signal);

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
    const children = graph.db.prepare("SELECT COUNT(DISTINCT transcript_id) AS n FROM fact WHERE session_id = ?").get(SESSION) as { n: number };
    expect(children.n).toBe(2);
  });

  it("counts the shared commit, push and assistant lines once", async () => {
    await refreshCorpus(graph, [basement(), mac()]);

    // Assistant lines: one shared, one basement-only, two mac-only.
    expect(sessionRow()[0]).toMatchObject({ turn_count: 4, commit_count: 1, push_count: 1 });
    const stored = graph.db.prepare("SELECT COUNT(*) AS n FROM session_signal WHERE signal = 'commit'").get() as { n: number };
    expect(stored.n).toBe(2);
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
    const owner = graph.db.prepare("SELECT transcript_id AS id FROM session").get() as { id: number };

    purgeTranscript(graph, owner.id);

    expect(sessionRow().map((r) => r.session_id)).toEqual([SESSION]);
    const turns = graph.db.prepare("SELECT COUNT(*) AS n FROM turn WHERE session_id = ?").get(SESSION) as { n: number };
    expect(turns.n).toBeGreaterThan(0);
    const repointed = graph.db.prepare("SELECT transcript_id AS id FROM session").get() as { id: number };
    expect(repointed.id).not.toBe(owner.id);
  });

  it("re-reads a shortened copy without phantom turns or dangling fact ids", async () => {
    await refreshCorpus(graph, [basement(), mac()]);
    const shortened = transcriptAt("claude-profiles/server/projects/p", SHARED, "server");
    const owner = graph.db.prepare("SELECT transcript_id AS id FROM session").get() as { id: number };

    purgeTranscript(graph, owner.id);
    await refreshCorpus(graph, [shortened, mac()]);

    const prompts = graph.db.prepare("SELECT prompt_id FROM turn ORDER BY prompt_id").all().map((r) => (r as { prompt_id: string }).prompt_id);
    expect(prompts).toEqual(["u-2026-10-01T00:00:00Z", "u-2026-10-01T02:00:00Z"]);
    const dangling = graph.db.prepare("SELECT COUNT(*) AS n FROM turn WHERE fact_id_start NOT IN (SELECT fact_id FROM fact)").get() as { n: number };
    expect(dangling.n).toBe(0);
  });

  it("drops only the purged copy's search spans", async () => {
    await refreshCorpus(graph, [basement(), mac()]);
    const owner = graph.db.prepare("SELECT transcript_id AS id FROM session").get() as { id: number };

    purgeTranscript(graph, owner.id);

    const sources = graph.db.prepare("SELECT DISTINCT source_id AS id FROM search_span").all() as { id: number }[];
    expect(sources.length).toBe(1);
    expect(sources[0]!.id).not.toBe(owner.id);
  });

  it("still counts a session read from one transcript as before", async () => {
    await refreshCorpus(graph, [basement()]);

    expect(sessionRow()[0]).toMatchObject({ turn_count: 2, commit_count: 1, push_count: 1 });
  });
});
