import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractTranscript, foldEvents, type DiscoveredTranscript, type SessionEvent, type TranscriptDelta } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDelta } from "./apply.js";
import { AUDIT_COLUMNS, AUDIT_MIGRATION_NAME, AUDIT_TABLES, FACET_TABLE, applyAuditSchema } from "./audit-schema.js";
import { openSessionGraph, resetIndex, type SessionGraph } from "./graph.js";
import { purgeTranscript } from "./purge.js";
import { refreshCorpus } from "./refresh.js";
import { MIGRATIONS } from "./schema.js";

const EVERY_AUDIT_TABLE = [...AUDIT_TABLES, FACET_TABLE] as const;

const line = (sessionId: string, fields: Record<string, unknown>) => ({ sessionId, cwd: "/scratch", gitBranch: "main", ...fields });
const prompt = (sessionId: string, ts: string) => line(sessionId, { type: "user", uuid: `u-${ts}`, timestamp: ts, message: { role: "user", content: "go" } });
const assistant = (sessionId: string, ts: string, requestId: string, outputTokens: number, content: unknown[] = [{ type: "text", text: "ok" }]) =>
  line(sessionId, {
    type: "assistant",
    timestamp: ts,
    requestId,
    message: { id: `msg-${requestId}`, role: "assistant", model: "claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: outputTokens }, content },
  });
const render = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

/** Every audit kind session-read emits from a line today: request, tool_call, compaction, queue_op, cost_state. */
const richLines = (sessionId: string) => [
  prompt(sessionId, "2026-09-01T00:00:00Z"),
  assistant(sessionId, "2026-09-01T00:00:01Z", `req-${sessionId}`, 4, [{ type: "tool_use", id: `tu-${sessionId}`, name: "Bash", input: { command: "ls" } }]),
  line(sessionId, { type: "queue-operation", timestamp: "2026-09-01T00:00:02Z", operation: "enqueue", content: "later" }),
  line(sessionId, { type: "system", subtype: "compact_boundary", timestamp: "2026-09-01T00:00:03Z", compactMetadata: { trigger: "auto", preTokens: 1000 } }),
  line(sessionId, { type: "cost-state", timestamp: "2026-09-01T00:00:04Z", totalCostUSD: 2, modelUsage: {} }),
];

/** Kinds whose emitters T7 wires; synthesised here so every audit table is exercised. */
function lateKinds(sessionId: string, byteOffset: number): TranscriptDelta {
  const base = { sessionId, ts: "2026-09-01T00:00:05Z", byteOffset, byteLength: 1, blockIndex: 0 };
  const events: SessionEvent[] = [
    { ...base, kind: "inbound", cause: "tool_result", delivery: "tool_result", detail: null, originServer: null, fromName: null, msgId: null, toolUseId: `tu-${sessionId}`, isError: true, contentHash: "h", chars: 3 },
    { ...base, kind: "context_block", source: "tool_result", toolUseId: `tu-${sessionId}`, attachmentType: null, chars: 3, isMedia: false },
    { ...base, kind: "signal", signal: "commit", detail: null, toolUseId: `tu-${sessionId}` },
  ];
  return foldEvents(events);
}

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-audit-"));
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: unknown[], account: string | null = null): DiscoveredTranscript {
  const absolutePath = path.join(dir, `${name}.jsonl`);
  writeFileSync(absolutePath, render(lines));
  return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account };
}

/** Index a transcript with every audit kind and a facet row; returns its transcript id. */
async function indexRich(sessionId: string): Promise<number> {
  const transcript = writeTranscript(sessionId, richLines(sessionId));
  const delta = await extractTranscript(transcript.absolutePath);
  const transcriptId = graph.transcripts.ensure(transcript.displayPath).sourceId;
  applyDelta(graph, transcriptId, { ...delta, ...pickLate(lateKinds(sessionId, delta.lastByteOffset)) });
  graph.db.prepare(`INSERT INTO ${FACET_TABLE} (transcript_id, facet, version, indexed_to) VALUES (?, 'audit', 1, ?)`).run(transcriptId, delta.lastByteOffset);
  return transcriptId;
}

const pickLate = (d: TranscriptDelta) => ({ inbound: d.inbound, contextBlocks: d.contextBlocks, signals: d.signals });
const count = (table: string, transcriptId?: number) =>
  transcriptId === undefined
    ? (graph.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n
    : (graph.db.prepare(`SELECT count(*) AS n FROM "${table}" WHERE transcript_id = ?`).get(transcriptId) as { n: number }).n;
const countsOf = (transcriptId?: number) => Object.fromEntries(EVERY_AUDIT_TABLE.map((t) => [t, count(t, transcriptId)]));
const columnsOf = (db: SessionGraph["db"], table: string) => (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((c) => c.name);

describe("migration 4", () => {
  /** The live graph's shape: session-graph at 3, plus active-work's own band at 1001 and 1002. */
  function versionThreeDatabase(file: string, prepare: (db: SessionGraph["db"]) => void = () => {}): void {
    const db = openDatabase(file);
    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 3));
    const record = db.prepare("INSERT INTO _migration (version, name, applied_at) VALUES (?, ?, '2026-09-01T00:00:00Z')");
    record.run(1001, "active-work tables");
    record.run(1002, "active-work follow-up");
    db.prepare("INSERT INTO session (session_id, cwd) VALUES ('kept', '/before')").run();
    prepare(db);
    db.close();
  }
  const migrationRows = (db: SessionGraph["db"]) => db.prepare("SELECT version, name, applied_at FROM _migration ORDER BY version").all() as { version: number; name: string }[];

  it("migration 4 applies on a version 3 database and is idempotent", () => {
    const file = path.join(dir, "graph.sqlite3");
    versionThreeDatabase(file);

    const first = openSessionGraph(file);
    const afterFirst = migrationRows(first.db);
    first.db.close();
    const second = openSessionGraph(file);
    const afterSecond = migrationRows(second.db);

    expect(afterFirst.map((r) => [r.version, r.name])).toEqual([
      [1, "kit tables"], [2, "session graph tables"], [3, "normalized conversations and source evidence"],
      [4, AUDIT_MIGRATION_NAME], [1001, "active-work tables"], [1002, "active-work follow-up"],
    ]);
    expect(AUDIT_MIGRATION_NAME).toBe("audit tables");
    expect(afterSecond).toEqual(afterFirst);
    for (const table of EVERY_AUDIT_TABLE) expect(columnsOf(second.db, table).length).toBeGreaterThan(0);
    for (const [table, column] of AUDIT_COLUMNS) expect(columnsOf(second.db, table)).toContain(column);
    expect(second.db.prepare("SELECT session_id, cwd, account FROM session").all()).toEqual([{ session_id: "kept", cwd: "/before", account: null }]);
    second.db.close();
  });

  it("a second ADD COLUMN run does not throw", () => {
    const file = path.join(dir, "repaired.sqlite3");
    versionThreeDatabase(file, (db) => db.exec("ALTER TABLE session ADD COLUMN account TEXT; ALTER TABLE pr ADD COLUMN closed_at TEXT"));

    const repaired = openSessionGraph(file);

    expect(() => applyAuditSchema(repaired.db)).not.toThrow();
    expect(columnsOf(repaired.db, "session").filter((c) => c === "account")).toHaveLength(1);
    expect(columnsOf(repaired.db, "pr")).toEqual(expect.arrayContaining(["review_rounds", "closed_at", "outcome_checked_at"]));
    repaired.db.close();
  });
});

describe("request rows", () => {
  const requests = () => graph.db.prepare("SELECT * FROM request ORDER BY transcript_id").all() as Record<string, unknown>[];

  it("three assistant lines with one requestId store one request row with MAX tokens and MIN byte_offset", async () => {
    const lines = [
      prompt("s1", "2026-09-01T00:00:00Z"),
      assistant("s1", "2026-09-01T00:00:01Z", "req_1", 3),
      assistant("s1", "2026-09-01T00:00:02Z", "req_1", 9),
      assistant("s1", "2026-09-01T00:00:03Z", "req_1", 7),
    ];
    const firstAssistantOffset = Buffer.byteLength(JSON.stringify(lines[0]) + "\n");

    await refreshCorpus(graph, [writeTranscript("s1", lines)]);

    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toMatchObject({
      request_id: "req_1", session_id: "s1", message_id: "msg-req_1", model: "claude-opus-5",
      byte_offset: firstAssistantOffset, ts: "2026-09-01T00:00:01Z",
      output_tokens: 9, input_tokens: 10, cache_read_tokens: 100, cache_creation_tokens: 5, context_tokens: 115,
    });
  });

  it("the same requestId in two transcripts stores two rows", async () => {
    const a = writeTranscript("a", [prompt("sa", "2026-09-01T00:00:00Z"), assistant("sa", "2026-09-01T00:00:01Z", "req_shared", 4)]);
    const b = writeTranscript("b", [prompt("sb", "2026-09-01T00:00:00Z"), assistant("sb", "2026-09-01T00:00:01Z", "req_shared", 4)]);

    await refreshCorpus(graph, [a, b]);

    expect(requests().map((r) => [r.request_id, r.session_id])).toEqual([["req_shared", "sa"], ["req_shared", "sb"]]);
  });
});

describe("audit apply, purge and reset", () => {
  it("re-applying a delta changes no row counts", async () => {
    const transcript = writeTranscript("s1", richLines("s1"));
    const delta = await extractTranscript(transcript.absolutePath);
    const full = { ...delta, ...pickLate(lateKinds("s1", delta.lastByteOffset)) };
    const transcriptId = graph.transcripts.ensure(transcript.displayPath).sourceId;
    applyDelta(graph, transcriptId, full);
    const once = countsOf();

    applyDelta(graph, transcriptId, full);

    expect(countsOf()).toEqual(once);
    for (const table of AUDIT_TABLES) expect(once[table], table).toBe(1);
  });

  it("purgeTranscript removes that transcript's audit rows and no other transcript's", async () => {
    const doomed = await indexRich("s1");
    const survivor = await indexRich("s2");
    const survivorBefore = countsOf(survivor);

    purgeTranscript(graph, doomed);

    expect(Object.values(countsOf(doomed))).toEqual(EVERY_AUDIT_TABLE.map(() => 0));
    expect(countsOf(survivor)).toEqual(survivorBefore);
    expect(Object.values(survivorBefore).every((n) => n === 1)).toBe(true);
  });

  it("resetIndex clears every audit table", async () => {
    await indexRich("s1");
    await indexRich("s2");

    resetIndex(graph);

    expect(Object.values(countsOf())).toEqual(EVERY_AUDIT_TABLE.map(() => 0));
  });

  it("session.account is written from discovery", async () => {
    const work = writeTranscript("w", [prompt("sw", "2026-09-01T00:00:00Z")], "work");
    const unknown = writeTranscript("u", [prompt("su", "2026-09-01T00:00:00Z")], null);

    await refreshCorpus(graph, [work, unknown]);

    expect(graph.db.prepare("SELECT session_id, account FROM session ORDER BY session_id").all()).toEqual([
      { session_id: "su", account: null },
      { session_id: "sw", account: "work" },
    ]);
  });
});
