import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUDIT_FACET, openSessionGraph, syncPrices, type SessionGraph } from "@titan-design/session-graph";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { PRICE_TABLE, PRICE_TABLE_VERSION, type PriceRow } from "./prices.js";

/** A session graph on a temp file, written through direct inserts. Test support, not exported. */
export interface FixtureGraph {
  graph: SessionGraph;
  /** A second, read-only connection: what the report is handed. */
  openReadOnly(): Db;
  close(): void;
}

export function createFixtureGraph(): FixtureGraph {
  const dir = mkdtempSync(path.join(os.tmpdir(), "titan-session-analytics-"));
  const file = path.join(dir, "graph.sqlite3");
  const graph = openSessionGraph(file);
  const readers: Db[] = [];
  return {
    graph,
    openReadOnly() {
      const db = openDatabase(file, { readonly: true });
      readers.push(db);
      return db;
    },
    close() {
      for (const db of readers) db.close();
      graph.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertPrices(graph: SessionGraph, rows: readonly PriceRow[] = PRICE_TABLE, tableVersion = PRICE_TABLE_VERSION): void {
  syncPrices(graph, rows, { tableVersion, source: "fixture" });
}

export interface RequestFixture {
  sessionId: string;
  ts: string;
  model?: string;
  requestId?: string;
  transcriptId?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreation5m?: number;
  cacheCreation1h?: number;
  /** Defaults to the 5m plus 1h split; set alone to model a record with no TTL split. */
  cacheCreationTokens?: number;
  outputTokens?: number;
  gapMs?: number | null;
  wakeCause?: string | null;
  wakeDelivery?: string | null;
}

let nextOffset = 0;

export function insertRequest(db: Db, request: RequestFixture): void {
  const r = { model: "claude-opus-5", transcriptId: 1, inputTokens: 0, cacheReadTokens: 0, cacheCreation5m: 0, cacheCreation1h: 0, outputTokens: 0, gapMs: null, wakeCause: null, wakeDelivery: null, ...request };
  const creation = r.cacheCreationTokens ?? r.cacheCreation5m + r.cacheCreation1h;
  nextOffset += 1;
  db.prepare(
    `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, input_tokens, cache_read_tokens,
       cache_creation_tokens, cache_creation_5m, cache_creation_1h, output_tokens, context_tokens, gap_ms, wake_cause, wake_delivery)
     VALUES (@transcriptId, @requestId, @offset, @sessionId, @ts, @model, @inputTokens, @cacheReadTokens,
       @creation, @cacheCreation5m, @cacheCreation1h, @outputTokens, @context, @gapMs, @wakeCause, @wakeDelivery)`,
  ).run({ ...r, requestId: r.requestId ?? `req-${nextOffset}`, offset: nextOffset, creation, context: r.inputTokens + r.cacheReadTokens + creation });
}

export interface SessionFixture {
  sessionId: string;
  cwd?: string | null;
  startType?: string | null;
  account?: string | null;
  seedPrompt?: string | null;
}

export function insertSession(db: Db, session: SessionFixture): void {
  db.prepare("INSERT INTO session (session_id, cwd, start_type, account, seed_prompt) VALUES (@sessionId, @cwd, @startType, @account, @seedPrompt)").run({
    cwd: null, startType: "cli", account: null, seedPrompt: null, ...session,
  });
}

export function insertOrigin(db: Db, origin: { sessionId: string; depth: number; profile?: string | null; parentName?: string | null }): void {
  db.prepare(
    `INSERT INTO session_origin (session_id, origin_system, depth, profile, parent_name, resolved_at)
     VALUES (@sessionId, 'agent-chat', @depth, @profile, @parentName, '2026-09-01T00:00:00Z')`,
  ).run({ profile: null, parentName: null, ...origin });
}

export function insertInbound(db: Db, inbound: { sessionId: string; ts: string; cause: string; delivery?: string }): void {
  nextOffset += 1;
  db.prepare(
    `INSERT INTO inbound (transcript_id, byte_offset, block_index, session_id, ts, cause, delivery, content_hash, chars)
     VALUES (1, @offset, 0, @sessionId, @ts, @cause, @delivery, 'h', 1)`,
  ).run({ delivery: "turn_start", ...inbound, offset: nextOffset });
}

export function insertCompaction(db: Db, compaction: { sessionId: string; ts: string; trigger: "manual" | "auto"; midLoop?: boolean; droppedTokens?: number }): void {
  nextOffset += 1;
  db.prepare(
    `INSERT INTO compaction (transcript_id, byte_offset, session_id, ts, trigger, mid_loop, dropped_tokens)
     VALUES (1, @offset, @sessionId, @ts, @trigger, @midLoop, @droppedTokens)`,
  ).run({ ...compaction, midLoop: compaction.midLoop ? 1 : 0, droppedTokens: compaction.droppedTokens ?? 0, offset: nextOffset });
}

/** A `ran` edge from the session to a task that names its initiative. */
export function insertTaskEdge(graph: SessionGraph, sessionId: string, taskId: string, initiative: string): void {
  graph.db.prepare("INSERT OR REPLACE INTO task (task_ref, task_id, initiative) VALUES (?, ?, ?)").run(`task:${taskId}`, taskId, initiative);
  graph.edges.assert({ sourceRef: `session:${sessionId}`, relation: "ran", targetRef: `task:${taskId}` });
}

/** An indexed transcript, with an audit facet at `facetVersion` unless it is null. */
export function insertTranscript(graph: SessionGraph, sourceKey: string, facetVersion: number | null): void {
  const { sourceId } = graph.transcripts.ensure(sourceKey);
  if (facetVersion === null) return;
  graph.db.prepare("INSERT INTO transcript_facet (transcript_id, facet, version, indexed_to) VALUES (?, ?, ?, 0)").run(sourceId, AUDIT_FACET, facetVersion);
}

export const SCENARIO_WINDOW = { since: "2026-09-20", until: "2026-09-21" } as const;

/**
 * Three sessions inside the window and two requests just outside it. `coord` is a human coordinator,
 * `worker` an implementer, `miner` a headless run on a model with no price row.
 */
export function seedCostScenario(fixture: FixtureGraph): void {
  const db = fixture.graph.db;
  insertPrices(fixture.graph);
  insertSession(db, { sessionId: "coord", cwd: "/Users/h/projects/titan-platform", account: "default" });
  insertSession(db, { sessionId: "worker", cwd: "/Users/h/projects/titan-platform/.worktrees/t1", startType: "sdk-cli", account: "work" });
  insertSession(db, { sessionId: "miner", cwd: "/tmp/miner", startType: "sdk-cli", account: "default" });
  insertOrigin(db, { sessionId: "worker", depth: 1, profile: "implementer", parentName: "coord" });
  insertInbound(db, { sessionId: "coord", ts: "2026-09-20T12:01:00Z", cause: "channel_message", delivery: "mid_loop" });
  seedScenarioRequests(db);
  insertCompaction(db, { sessionId: "coord", ts: "2026-09-20T12:30:00Z", trigger: "manual", droppedTokens: 90_000 });
  insertCompaction(db, { sessionId: "worker", ts: "2026-09-20T13:30:00Z", trigger: "auto", midLoop: true, droppedTokens: 10_000 });
  insertCompaction(db, { sessionId: "worker", ts: "2026-09-21T01:00:00Z", trigger: "auto" });
  insertTranscript(fixture.graph, "coord.jsonl", 3);
  insertTranscript(fixture.graph, "worker.jsonl", 3);
  insertTranscript(fixture.graph, "miner.jsonl", null);
}

function seedScenarioRequests(db: Db): void {
  const coord = { sessionId: "coord" };
  insertRequest(db, { ...coord, ts: "2026-09-20T10:00:00Z", inputTokens: 1_000, outputTokens: 500, wakeCause: "human_typed", wakeDelivery: "turn_start" });
  insertRequest(db, { ...coord, ts: "2026-09-20T12:00:00Z", cacheReadTokens: 1_000, cacheCreation1h: 50_000, outputTokens: 100, gapMs: 7_200_000, wakeCause: "ask_user_answer", wakeDelivery: "turn_start" });
  insertRequest(db, { ...coord, ts: "2026-09-20T12:01:00Z", model: "claude-fable-5-1", cacheReadTokens: 120_000, outputTokens: 200, gapMs: 60_000, wakeCause: "channel_message", wakeDelivery: "mid_loop" });
  insertRequest(db, { ...coord, ts: "2026-09-20T12:02:00Z", model: "claude-sonnet-5", inputTokens: 10, cacheReadTokens: 60_000, cacheCreationTokens: 2_000, outputTokens: 50, gapMs: 60_000, wakeCause: "channel_message", wakeDelivery: "turn_start" });
  insertRequest(db, { sessionId: "worker", ts: "2026-09-20T13:00:00Z", model: "claude-haiku-4-5", inputTokens: 500, cacheCreation5m: 30_000, outputTokens: 1_000, gapMs: 1_000, wakeCause: "tool_result", wakeDelivery: "tool_result" });
  insertRequest(db, { sessionId: "miner", ts: "2026-09-20T14:00:00Z", model: "claude-mystery-9", inputTokens: 100, outputTokens: 10, wakeCause: "human_typed", wakeDelivery: "turn_start" });
  insertRequest(db, { ...coord, ts: "2026-09-19T23:59:59Z", inputTokens: 999_999, wakeCause: "human_typed" });
  insertRequest(db, { ...coord, ts: "2026-09-21T00:00:00Z", inputTokens: 999_999, wakeCause: "human_typed" });
}
