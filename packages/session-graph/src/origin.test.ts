import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredTranscript } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORIGIN_MIGRATION_NAME, ORIGIN_TABLES } from "./audit-schema-v5.js";
import { openSessionGraph, resetIndex, type SessionGraph } from "./graph.js";
import { NO_ORIGINS, type OriginResolution, type OriginResolver } from "./origin.js";
import { purgeTranscript } from "./purge.js";
import { refreshCorpus } from "./refresh.js";
import { MIGRATIONS } from "./schema.js";

const line = (sessionId: string, fields: Record<string, unknown>) => ({ sessionId, cwd: "/scratch", gitBranch: "main", ...fields });
const prompt = (sessionId: string, ts: string) => line(sessionId, { type: "user", uuid: `u-${sessionId}-${ts}`, timestamp: ts, message: { role: "user", content: "go" } });
const assistant = (sessionId: string, ts: string) =>
  line(sessionId, {
    type: "assistant", timestamp: ts, requestId: `req-${sessionId}-${ts}`,
    message: { role: "assistant", model: "m", usage: { input_tokens: 1, output_tokens: 2 }, content: [{ type: "text", text: "ok" }] },
  });

const PARENT_END = "2026-09-01T00:00:03Z";
const WORKER_END = "2026-09-01T00:05:09Z";

let dir: string;
let graph: SessionGraph;

function transcriptFor(sessionId: string, start: string, end: string): DiscoveredTranscript {
  const absolutePath = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(absolutePath, [prompt(sessionId, start), assistant(sessionId, end)].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
}

const corpus = () => [
  transcriptFor("parent", "2026-09-01T00:00:00Z", PARENT_END),
  transcriptFor("worker", "2026-09-01T00:05:00Z", WORKER_END),
];

const WORKER_ORIGIN: OriginResolution = {
  origins: {
    worker: {
      originSystem: "agent-chat", agentId: "a-42", agentName: "sm-t12", parentName: "tp-sm-wave2", parentSessionId: "parent",
      profile: "implementer", depth: 1, originKind: "spawned", spawnedAt: "2026-09-01T00:04:59Z", briefChars: 1200, briefExcerpt: "TASK: T12",
    },
  },
};
const answer = (resolution: OriginResolution): OriginResolver => () => resolution;

const rows = (sql: string) => graph.db.prepare(sql).all() as Record<string, unknown>[];
const originRows = () => rows("SELECT session_id, origin_system, agent_id, agent_name, parent_session_id, profile, depth, origin_kind, brief_chars FROM session_origin");
const subagentRows = () => rows("SELECT agent_ref, session_id, child_session_id, agent_type, label, started_at, ended_at FROM subagent");
const spawnedSessions = () => graph.edges.from("session:parent").filter((e) => e.relation === "spawned").map((e) => e.targetRef);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-graph-origin-"));
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration 5", () => {
  /** The live graph's shape: session-graph at 4, plus active-work's own band at 1001 and 1002. */
  function versionFourDatabase(file: string): void {
    const db = openDatabase(file);
    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 4));
    const record = db.prepare("INSERT INTO _migration (version, name, applied_at) VALUES (?, ?, '2026-09-01T00:00:00Z')");
    record.run(1001, "active-work tables");
    record.run(1002, "active-work follow-up");
    db.prepare("INSERT INTO session (session_id, cwd) VALUES ('kept', '/before')").run();
    db.close();
  }
  const schemaOf = (db: SessionGraph["db"]) => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  const migrationRows = (db: SessionGraph["db"]) => db.prepare("SELECT version, name, applied_at FROM _migration ORDER BY version").all() as { version: number; name: string }[];

  it("applies on the live version 4 shape and a second open changes nothing", () => {
    const file = path.join(dir, "graph.sqlite3");
    versionFourDatabase(file);

    const first = openSessionGraph(file);
    const [migrationsAfterFirst, schemaAfterFirst] = [migrationRows(first.db), schemaOf(first.db)];
    first.db.close();
    const second = openSessionGraph(file);

    expect(migrationsAfterFirst.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 1001, 1002]);
    expect(migrationsAfterFirst.find((r) => r.version === 5)?.name).toBe("origin, episodes, prices");
    expect(ORIGIN_MIGRATION_NAME).toBe("origin, episodes, prices");
    expect(migrationRows(second.db)).toEqual(migrationsAfterFirst);
    expect(schemaOf(second.db)).toEqual(schemaAfterFirst);
    for (const view of ["request_dedup", "request_cost", "context_contribution"]) expect(() => second.db.prepare(`SELECT * FROM ${view}`).all()).not.toThrow();
    expect(second.db.prepare("SELECT session_id, cwd FROM session").all()).toEqual([{ session_id: "kept", cwd: "/before" }]);
    second.db.close();
  });
});

describe("origin resolver", () => {
  it("writes session_origin for a resolved session", async () => {
    const summary = await refreshCorpus(graph, corpus(), { resolveOrigins: answer(WORKER_ORIGIN) });

    expect(summary.origins).toEqual({ requested: 2, applied: 1, events: 0, failed: false });
    expect(originRows()).toEqual([
      { session_id: "worker", origin_system: "agent-chat", agent_id: "a-42", agent_name: "sm-t12", parent_session_id: "parent", profile: "implementer", depth: 1, origin_kind: "spawned", brief_chars: 1200 },
    ]);
  });

  it("adds a spawned edge from parent to child and a subagent row whose child_session_id is the worker", async () => {
    await refreshCorpus(graph, corpus(), { resolveOrigins: answer(WORKER_ORIGIN) });

    expect(spawnedSessions()).toEqual(["session:worker"]);
    expect(subagentRows()).toEqual([
      expect.objectContaining({ agent_ref: "agent:agent-chat:a-42", session_id: "parent", child_session_id: "worker", agent_type: "implementer", label: "sm-t12", started_at: "2026-09-01T00:04:59Z" }),
    ]);
  });

  it("RECONCILE_SUBAGENTS fills ended_at for an agent-chat worker", async () => {
    const summary = await refreshCorpus(graph, corpus(), { resolveOrigins: answer(WORKER_ORIGIN) });

    expect(summary.reconciled.subagents).toBeGreaterThan(0);
    expect(subagentRows()[0]?.ended_at).toBe(WORKER_END);
  });

  it("records external events under the session's origin system", async () => {
    const events = [{ sessionId: "worker", ts: "2026-09-01T00:06:00Z", kind: "retired", detail: "done" }];
    const summary = await refreshCorpus(graph, corpus(), { resolveOrigins: answer({ ...WORKER_ORIGIN, externalEvents: events }) });

    expect(summary.origins.events).toBe(1);
    expect(rows("SELECT * FROM session_external_event")).toEqual([
      { session_id: "worker", ts: "2026-09-01T00:06:00Z", origin_system: "agent-chat", kind: "retired", detail: "done" },
    ]);
  });

  it("asks only for sessions without an origin row or with a stale one", async () => {
    const transcripts = [...corpus(), transcriptFor("fresh", "2026-09-01T00:07:00Z", "2026-09-01T00:07:05Z")];
    await refreshCorpus(graph, transcripts);
    const stamp = graph.db.prepare("INSERT INTO session_origin (session_id, origin_system, resolved_at) VALUES (?, 'agent-chat', ?)");
    stamp.run("fresh", "2026-09-01T00:08:00Z");
    stamp.run("worker", "2026-09-01T00:05:01Z");
    const asked: string[][] = [];

    await refreshCorpus(graph, transcripts, { resolveOrigins: (ids) => (asked.push([...ids]), { origins: {} }) });

    expect(asked).toEqual([["parent", "worker"]]);
  });

  it("survives a resolver that throws", async () => {
    const summary = await refreshCorpus(graph, corpus(), {
      resolveOrigins: () => {
        throw new Error("events.db is locked");
      },
    });

    expect(summary).toMatchObject({ indexed: 2, origins: { requested: 2, applied: 0, events: 0, failed: true, error: "events.db is locked" } });
    expect(originRows()).toEqual([]);
    expect(rows("SELECT session_id FROM session ORDER BY session_id")).toEqual([{ session_id: "parent" }, { session_id: "worker" }]);
  });

  it("changes nothing with no resolver", async () => {
    await refreshCorpus(graph, corpus(), { resolveOrigins: answer(WORKER_ORIGIN) });
    const before = [originRows(), subagentRows(), graph.edges.from("session:parent")];

    const summary = await refreshCorpus(graph, corpus());

    expect(summary.origins).toEqual(NO_ORIGINS);
    expect([originRows(), subagentRows(), graph.edges.from("session:parent")]).toEqual(before);
  });

  it("restores the worker's subagent row after the parent transcript is purged", async () => {
    await refreshCorpus(graph, corpus(), { resolveOrigins: answer(WORKER_ORIGIN) });
    purgeTranscript(graph, 1);
    expect(subagentRows()).toEqual([]);

    await refreshCorpus(graph, corpus(), { resolveOrigins: answer({ origins: {} }) });

    expect(subagentRows()).toEqual([expect.objectContaining({ agent_ref: "agent:agent-chat:a-42", child_session_id: "worker", ended_at: WORKER_END })]);
  });

  it("resetIndex clears origin rows so the next pass asks again", async () => {
    await refreshCorpus(graph, corpus(), { resolveOrigins: answer(WORKER_ORIGIN) });

    resetIndex(graph);

    for (const table of ORIGIN_TABLES) expect(rows(`SELECT * FROM ${table}`)).toEqual([]);
  });
});

describe("request_dedup", () => {
  const insertRequest = (r: { transcriptId: number; requestId: string; ts: string; outputTokens: number }) =>
    graph.db
      .prepare("INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, output_tokens) VALUES (?, ?, 0, 's', ?, 'm', ?)")
      .run(r.transcriptId, r.requestId, r.ts, r.outputTokens);

  it("request_dedup returns one row for a requestId present in two transcripts, the earliest", () => {
    insertRequest({ transcriptId: 1, requestId: "req-fan", ts: "2026-09-01T00:00:05Z", outputTokens: 10 });
    insertRequest({ transcriptId: 2, requestId: "req-fan", ts: "2026-09-01T00:00:04Z", outputTokens: 10 });
    insertRequest({ transcriptId: 2, requestId: "req-solo", ts: "2026-09-01T00:00:06Z", outputTokens: 3 });

    const deduped = rows("SELECT transcript_id, request_id, ts FROM request_dedup ORDER BY request_id");

    expect(deduped).toEqual([
      { transcript_id: 2, request_id: "req-fan", ts: "2026-09-01T00:00:04Z" },
      { transcript_id: 2, request_id: "req-solo", ts: "2026-09-01T00:00:06Z" },
    ]);
  });
});

describe("context_contribution", () => {
  it("attributes a request's whole ctx_delta to the tool_result block, not the assistant text before it", () => {
    const request = graph.db.prepare("INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, ctx_delta) VALUES (1, ?, ?, 's', ?, 'm', ?)");
    request.run("req-prev", 100, "2026-09-01T00:00:01Z", null);
    request.run("req-next", 300, "2026-09-01T00:00:03Z", 500);
    const block = graph.db.prepare("INSERT INTO context_block (transcript_id, byte_offset, block_index, session_id, ts, source, chars) VALUES (1, ?, 0, 's', 't', ?, ?)");
    block.run(100, "assistant_text", 400);
    block.run(200, "tool_result", 100);

    const shares = rows("SELECT source, request_id, est_tokens FROM context_contribution ORDER BY byte_offset");

    expect(shares).toEqual([
      { source: "assistant_text", request_id: "req-next", est_tokens: null },
      { source: "tool_result", request_id: "req-next", est_tokens: 500 },
    ]);
  });
});
