import { appendFileSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXTRACT_VERSION, type DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_TABLES, FACET_TABLE } from "./audit-schema.js";
import { backfillFacets } from "./facet.js";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { refreshCorpus } from "./refresh.js";
import { rollupSessions } from "./rollup.js";

const EVERY_AUDIT_TABLE = [...AUDIT_TABLES, FACET_TABLE] as const;
const LEGACY_TABLES = ["fact", "turn", "session", "session_model_usage"] as const;

const line = (sessionId: string, fields: Record<string, unknown>) => ({ sessionId, cwd: "/scratch", gitBranch: "main", ...fields });
const prompt = (sessionId: string, ts: string) => line(sessionId, { type: "user", uuid: `u-${sessionId}-${ts}`, timestamp: ts, message: { role: "user", content: "go" } });
const assistant = (sessionId: string, ts: string, requestId: string, content: unknown[] = [{ type: "text", text: "ok" }]) =>
  line(sessionId, {
    type: "assistant",
    timestamp: ts,
    requestId,
    message: { id: `msg-${requestId}`, role: "assistant", model: "claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 4 }, content },
  });
const render = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

const firstHalf = (sessionId: string) => [
  prompt(sessionId, "2026-09-01T00:00:00Z"),
  assistant(sessionId, "2026-09-01T00:00:01Z", `req-${sessionId}-1`, [{ type: "tool_use", id: `tu-${sessionId}`, name: "Bash", input: { command: "git commit -m x" } }]),
  line(sessionId, { type: "user", timestamp: "2026-09-01T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${sessionId}`, content: "ok" }] } }),
  line(sessionId, { type: "queue-operation", timestamp: "2026-09-01T00:00:03Z", operation: "enqueue", content: "later" }),
];
const secondHalf = (sessionId: string) => [
  prompt(sessionId, "2026-09-01T00:01:00Z"),
  assistant(sessionId, "2026-09-01T00:01:01Z", `req-${sessionId}-2`),
  line(sessionId, { type: "system", subtype: "compact_boundary", timestamp: "2026-09-01T00:01:02Z", compactMetadata: { trigger: "auto", preTokens: 1000 } }),
  line(sessionId, { type: "cost-state", timestamp: "2026-09-01T00:01:03Z", totalCostUSD: 2, modelUsage: {} }),
];

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-facet-"));
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[], mtime?: Date): DiscoveredTranscript {
  const absolutePath = path.join(dir, `${name}.jsonl`);
  writeFileSync(absolutePath, render(lines));
  if (mtime) utimesSync(absolutePath, mtime, mtime);
  return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
}

/** The state migration 4 leaves behind: legacy rows present, audit tables empty. */
function forgetAudit(target: SessionGraph = graph): void {
  for (const table of EVERY_AUDIT_TABLE) target.db.exec(`DELETE FROM "${table}"`);
}

const count = (table: string, transcriptId?: number) =>
  transcriptId === undefined
    ? (graph.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n
    : (graph.db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE transcript_id = ?`).get(transcriptId) as { n: number }).n;
const dump = (target: SessionGraph, tables: readonly string[]) =>
  Object.fromEntries(tables.map((t) => [t, target.db.prepare(`SELECT * FROM "${t}" ORDER BY 1, 2, 3`).all()]));
const facetOf = (transcriptId: number) =>
  graph.db.prepare(`SELECT version, indexed_to FROM ${FACET_TABLE} WHERE transcript_id = ? AND facet = 'audit'`).get(transcriptId) as { version: number; indexed_to: number } | undefined;
const idOf = (transcript: DiscoveredTranscript) => graph.transcripts.ensure(transcript.displayPath).sourceId;

describe("backfillFacets", () => {
  it("a transcript indexed before the audit tables existed gains request rows without changing fact, turn or session counts", async () => {
    const transcript = writeTranscript("s1", [...firstHalf("s1"), ...secondHalf("s1")]);
    await refreshCorpus(graph, [transcript]);
    forgetAudit();
    const legacy = dump(graph, LEGACY_TABLES);

    const summary = await refreshCorpus(graph, [transcript]);

    expect(summary).toMatchObject({ unchanged: 1, facetsBackfilled: 1, facetBacklog: 0, turnsRolledUp: 2 });
    expect(count("request")).toBe(2);
    expect(dump(graph, LEGACY_TABLES)).toEqual(legacy);
    expect(facetOf(idOf(transcript))).toEqual({ version: EXTRACT_VERSION, indexed_to: graph.transcripts.ensure(transcript.displayPath).lastOffset });
  });

  it("backfill equals a fresh index for every audit table", async () => {
    const transcripts = [writeTranscript("s1", firstHalf("s1")), writeTranscript("s2", firstHalf("s2"))];
    await refreshCorpus(graph, transcripts);
    forgetAudit();
    // An append indexed forward onto a legacy transcript must not mark the facet current.
    for (const t of transcripts) appendFileSync(t.absolutePath, render(secondHalf(path.basename(t.absolutePath, ".jsonl"))));
    await refreshCorpus(graph, transcripts);

    const fresh = openSessionGraph(":memory:");
    await refreshCorpus(fresh, transcripts);

    expect(dump(graph, EVERY_AUDIT_TABLE)).toEqual(dump(fresh, EVERY_AUDIT_TABLE));
    expect(count("request")).toBe(4);
    fresh.db.close();
  });

  it("a transcript at the current EXTRACT_VERSION is skipped", async () => {
    const transcript = writeTranscript("s1", firstHalf("s1"));
    await refreshCorpus(graph, [transcript]);
    graph.db.prepare("UPDATE request SET output_tokens = 999").run();

    const summary = await backfillFacets(graph, [transcript]);

    expect(summary).toEqual({ backfilled: 0, backlog: 0, sessionIds: [] });
    expect(graph.db.prepare("SELECT output_tokens FROM request").get()).toEqual({ output_tokens: 999 });
  });

  it("bumping EXTRACT_VERSION re-extracts and replaces, not duplicates", async () => {
    const transcript = writeTranscript("s1", [...firstHalf("s1"), ...secondHalf("s1")]);
    await refreshCorpus(graph, [transcript]);
    const transcriptId = idOf(transcript);
    const before = dump(graph, AUDIT_TABLES);
    graph.db.prepare("UPDATE request SET output_tokens = 999").run();
    graph.db.prepare("INSERT INTO tool_call (transcript_id, byte_offset, block_index, session_id, ts, tool_use_id, name, family, input_chars) VALUES (?, 1, 9, 's1', 't', 'stale', 'Old', 'builtin', 0)").run(transcriptId);

    const summary = await backfillFacets(graph, [transcript], { version: EXTRACT_VERSION + 1 });
    // Rollup-owned columns are refilled by the caller's rollup over the returned sessions, as refreshCorpus does.
    rollupSessions(graph, summary.sessionIds);

    expect(summary).toEqual({ backfilled: 1, backlog: 0, sessionIds: ["s1"] });
    expect(dump(graph, AUDIT_TABLES)).toEqual(before);
    expect(facetOf(transcriptId)?.version).toBe(EXTRACT_VERSION + 1);
    expect(await backfillFacets(graph, [transcript], { version: EXTRACT_VERSION + 1 })).toMatchObject({ backfilled: 0 });
  });

  it("limit caps the transcripts visited per pass and the backlog count is reported", async () => {
    const transcripts = ["old", "mid", "new"].map((name, i) => writeTranscript(name, firstHalf(name), new Date(Date.UTC(2026, 8, 1 + i))));
    await refreshCorpus(graph, transcripts);
    forgetAudit();

    const first = await backfillFacets(graph, transcripts, { limit: 2 });

    expect(first).toMatchObject({ backfilled: 2, backlog: 1 });
    expect(first.sessionIds.sort()).toEqual(["mid", "new"]);
    expect(facetOf(idOf(transcripts[0]!))).toBeUndefined();
    const second = await refreshCorpus(graph, transcripts, { facetLimit: 2 });
    expect(second).toMatchObject({ facetsBackfilled: 1, facetBacklog: 0 });
    expect(count("request")).toBe(3);
  });

  it("missing and quarantined transcripts are skipped", async () => {
    const [ok, missing, quarantined] = ["ok", "gone", "bad"].map((name) => writeTranscript(name, firstHalf(name))) as [DiscoveredTranscript, DiscoveredTranscript, DiscoveredTranscript];
    await refreshCorpus(graph, [ok, missing, quarantined]);
    forgetAudit();
    unlinkSync(missing.absolutePath);
    appendFileSync(quarantined.absolutePath, "{not json\n");
    await refreshCorpus(graph, [ok, quarantined], { facetLimit: 0 });

    const summary = await backfillFacets(graph, [ok, missing, quarantined]);

    expect(graph.transcripts.ensure(missing.displayPath).status).toBe("missing");
    expect(graph.transcripts.ensure(quarantined.displayPath).status).toBe("quarantined");
    expect(summary).toEqual({ backfilled: 1, backlog: 0, sessionIds: ["ok"] });
    expect(count("request", idOf(quarantined))).toBe(0);
    expect(count(FACET_TABLE)).toBe(1);
  });
});
