import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionContexts } from "./cost-report-queries.js";
import { EPISODE_REQUESTS_SQL, buildEpisodes, readEpisodeInput, staleEpisodeSessions, writeEpisodes, type EpisodeInput } from "./episodes.js";
import { createFixtureGraph, insertInbound, insertOrigin, insertRequest, insertSession, insertSignal, type FixtureGraph } from "./fixture.js";

const BASE_MS = Date.parse("2026-09-20T10:00:00Z");
const at = (minute: number) => new Date(BASE_MS + minute * 60_000).toISOString();

/** Events in chronological order; each takes the next byte offset, as lines in one transcript would. */
function transcript() {
  const input: EpisodeInput & { requests: EpisodeInput["requests"][number][]; inbounds: EpisodeInput["inbounds"][number][]; signals: EpisodeInput["signals"][number][] } = {
    requests: [], inbounds: [], signals: [], spawned: true,
  };
  let offset = 0;
  const api = {
    input,
    request(minute: number, extra: { contextTokens?: number; wakeCause?: string; transcriptId?: number } = {}) {
      input.requests.push({ offset: ++offset, ts: at(minute), transcriptId: extra.transcriptId ?? 1, contextTokens: extra.contextTokens ?? 1_000, wakeCause: extra.wakeCause ?? null });
      return offset;
    },
    inbound(minute: number, cause: string, transcriptId = 1) {
      input.inbounds.push({ offset: ++offset, ts: at(minute), transcriptId, cause });
      return offset;
    },
    signal(minute: number, signal: string, transcriptId = 1) {
      input.signals.push({ offset: ++offset, ts: at(minute), transcriptId, signal });
      return offset;
    },
    /** A request per minute from `from` up to, not including, `to`. */
    requests(from: number, to: number, contextTokens?: number) {
      for (let minute = from; minute < to; minute++) api.request(minute, { contextTokens });
    },
  };
  return api;
}

describe("worker-v1", () => {
  it("opens an episode at the brief, at a channel message after a status report, and after a 30 minute idle gap", () => {
    const t = transcript();
    const brief = t.inbound(0, "human_typed");
    t.request(0);
    t.inbound(2, "channel_message");
    t.request(2);
    t.request(5);
    t.signal(5, "status_report");
    const followup = t.inbound(20, "channel_message");
    t.request(20);
    t.request(25);
    const woke = t.request(55);
    t.request(56);

    const rows = buildEpisodes(t.input, "worker-v1");

    expect(rows.map((row) => row.openedBy)).toEqual(["brief", "channel_followup", "idle_gap"]);
    expect(rows.map((row) => row.startOffset)).toEqual([brief, followup, woke]);
    expect(rows.map((row) => row.assignmentOffset)).toEqual([brief, followup, null]);
    expect(rows.map((row) => row.episodeIndex)).toEqual([0, 1, 2]);
    expect(rows[1]).toMatchObject({ startedAt: at(20), endedAt: at(25) });
  });

  it("does not open an idle-gap episode on the request a channel follow-up already opened", () => {
    const t = transcript();
    t.inbound(0, "human_typed");
    t.request(0);
    t.signal(0, "status_report");
    t.inbound(120, "channel_message");
    t.request(120);

    expect(buildEpisodes(t.input, "worker-v1").map((row) => row.openedBy)).toEqual(["brief", "channel_followup"]);
  });

  it("clusters channel messages within 10 minutes", () => {
    const t = transcript();
    t.inbound(0, "human_typed");
    t.request(0);
    t.signal(5, "status_report");
    const first = t.inbound(10, "channel_message");
    t.request(10);
    t.signal(12, "status_report");
    t.inbound(18, "channel_message");
    t.request(18);
    t.signal(20, "status_report");
    t.inbound(26, "channel_message");
    t.request(26);
    t.signal(28, "status_report");
    const second = t.inbound(40, "channel_message");
    t.request(40);

    const rows = buildEpisodes(t.input, "worker-v1");

    expect(rows.map((row) => row.openedBy)).toEqual(["brief", "channel_followup", "channel_followup"]);
    expect(rows.map((row) => row.startOffset).slice(1)).toEqual([first, second]);
  });

  it("records the first status report separately from the first deliverable", () => {
    const t = transcript();
    t.inbound(0, "human_typed");
    t.request(0);
    const commit = t.signal(3, "commit");
    t.request(4);
    const status = t.signal(8, "status_report");
    t.signal(9, "status_report");

    const [row] = buildEpisodes(t.input, "worker-v1");

    expect(row).toMatchObject({ firstDeliverableOffset: commit, firstDeliverableSignal: "commit", firstStatusOffset: status });
  });

  it("opens at session_start when the session has no brief", () => {
    const t = transcript();
    t.input.spawned = false;
    t.request(0);

    expect(buildEpisodes(t.input, "worker-v1")).toMatchObject([{ openedBy: "session_start", assignmentOffset: null }]);
  });

  it("episode boundaries stay ordered for a session resumed across two transcripts", () => {
    const input: EpisodeInput = {
      spawned: true,
      requests: [
        { offset: 500, ts: at(0), transcriptId: 1, contextTokens: 1_000, wakeCause: null },
        { offset: 900, ts: at(5), transcriptId: 1, contextTokens: 1_000, wakeCause: null },
        // the resumed transcript's byte offsets restart from a fresh file, well below transcript 1's
        { offset: 20, ts: at(40), transcriptId: 2, contextTokens: 1_000, wakeCause: null },
        { offset: 150, ts: at(45), transcriptId: 2, contextTokens: 1_000, wakeCause: null },
      ],
      inbounds: [{ offset: 10, ts: at(0), transcriptId: 1, cause: "human_typed" }],
      signals: [],
    };

    const rows = buildEpisodes(input, "worker-v1");

    expect(rows.map((row) => row.openedBy)).toEqual(["brief", "idle_gap"]);
    expect(rows.map((row) => row.startOffset)).toEqual([10, 20]);
    expect(rows.map((row) => row.endOffset)).toEqual([900, 150]);
    expect(rows.map((row) => row.startTranscriptId)).toEqual([1, 2]);
    expect(rows.map((row) => row.endTranscriptId)).toEqual([1, 2]);
  });
});

describe("coordinator-v1", () => {
  it("opens on an idle gap, a merge, a wrap and a context reset", () => {
    const t = transcript();
    t.requests(0, 10);
    t.requests(60, 70);
    t.signal(69, "pr_merge");
    t.requests(70, 80);
    t.signal(79, "task_wrap");
    t.requests(80, 89);
    t.request(89, { contextTokens: 50_000 });
    t.request(90, { contextTokens: 29_000 });
    t.requests(91, 100, 29_000);

    const rows = buildEpisodes(t.input, "coordinator-v1");

    expect(rows.map((row) => row.openedBy)).toEqual(["session_start", "idle_gap", "pr_merge", "task_wrap", "context_reset"]);
    expect(rows.map((row) => row.startedAt)).toEqual([at(0), at(60), at(70), at(80), at(90)]);
    expect(rows[0]!.endedAt).toBe(at(9));
  });

  it("keeps every episode at 8 requests or more and counts one merge per 15 requests", () => {
    const t = transcript();
    t.requests(0, 10);
    t.signal(3, "task_wrap");
    t.signal(9, "pr_merge");
    t.requests(10, 20);
    t.signal(19, "pr_merge");
    t.requests(20, 40);
    t.signal(39, "pr_merge");
    t.requests(40, 50);
    t.requests(80, 87);

    const rows = buildEpisodes(t.input, "coordinator-v1");

    expect(rows.map((row) => row.openedBy)).toEqual(["session_start", "pr_merge", "pr_merge"]);
    expect(rows.map((row) => row.startedAt)).toEqual([at(0), at(10), at(40)]);
    expect(rows.at(-1)!.endedAt).toBe(at(86));
  });

  it("opens when a spawn wave has gone 15 requests without agent-chat traffic", () => {
    const t = transcript();
    t.requests(0, 5);
    t.signal(4, "agent_spawn");
    t.requests(5, 9);
    t.request(9, { wakeCause: "channel_message" });
    t.requests(10, 30);

    expect(buildEpisodes(t.input, "coordinator-v1").map((row) => row.openedBy)).toEqual(["session_start", "spawn_wave_complete"]);
  });
});

describe("writeEpisodes", () => {
  let fixture: FixtureGraph;
  beforeEach(() => {
    fixture = createFixtureGraph();
  });
  afterEach(() => fixture.close());

  it("rows carry heuristic and version", () => {
    const db = fixture.graph.db;
    insertSession(db, { sessionId: "worker", startType: "sdk-cli" });
    insertOrigin(db, { sessionId: "worker", depth: 1, profile: "implementer" });
    insertSession(db, { sessionId: "human" });
    insertSession(db, { sessionId: "miner", startType: "sdk-cli" });
    insertInbound(db, { sessionId: "worker", ts: at(0), cause: "human_typed" });
    insertRequest(db, { sessionId: "worker", ts: at(0) });
    insertSignal(db, { sessionId: "worker", ts: at(1), signal: "status_report" });
    insertRequest(db, { sessionId: "human", ts: at(0) });
    insertRequest(db, { sessionId: "miner", ts: at(0) });

    const written = writeEpisodes(fixture.graph, ["worker", "human", "miner"]);
    const stored = db.prepare("SELECT session_id, heuristic, heuristic_version, opened_by, first_status_offset FROM episode ORDER BY session_id").all();

    expect(written.map((w) => w.sessionId).sort()).toEqual(["human", "worker"]);
    expect(stored).toEqual([
      { session_id: "human", heuristic: "coordinator-v1", heuristic_version: 1, opened_by: "session_start", first_status_offset: null },
      { session_id: "worker", heuristic: "worker-v1", heuristic_version: 1, opened_by: "brief", first_status_offset: expect.any(Number) },
    ]);
  });
});

describe("staleEpisodeSessions", () => {
  let fixture: FixtureGraph;
  beforeEach(() => {
    fixture = createFixtureGraph();
  });
  afterEach(() => fixture.close());

  function addWorker(sessionId: string, ts: string) {
    const db = fixture.graph.db;
    insertSession(db, { sessionId, startType: "sdk-cli" });
    insertOrigin(db, { sessionId, depth: 1, profile: "implementer" });
    insertInbound(db, { sessionId, ts, cause: "human_typed" });
    insertRequest(db, { sessionId, ts });
  }

  it("a session whose stored episodes end before its last main-thread request is stale", () => {
    addWorker("worker", at(0));
    writeEpisodes(fixture.graph, ["worker"]);
    insertRequest(fixture.graph.db, { sessionId: "worker", ts: at(5) });

    expect(staleEpisodeSessions(fixture.graph.db)).toEqual(["worker"]);
  });

  it("an up-to-date session is not stale, and a later sidechain request does not make it so", () => {
    addWorker("worker", at(0));
    writeEpisodes(fixture.graph, ["worker"]);
    insertRequest(fixture.graph.db, { sessionId: "worker", ts: at(5), isSidechain: true });

    expect(staleEpisodeSessions(fixture.graph.db)).toEqual([]);
  });

  it("a headless session is never stale", () => {
    insertSession(fixture.graph.db, { sessionId: "miner", startType: "sdk-cli" });
    insertRequest(fixture.graph.db, { sessionId: "miner", ts: at(0) });

    expect(staleEpisodeSessions(fixture.graph.db)).toEqual([]);
  });

  it("lists sessions with no stored episodes, most recently active first, limited to the ids given", () => {
    addWorker("worker", at(0));
    insertSession(fixture.graph.db, { sessionId: "human" });
    insertRequest(fixture.graph.db, { sessionId: "human", ts: at(3) });

    expect(staleEpisodeSessions(fixture.graph.db)).toEqual(["human", "worker"]);
    expect(staleEpisodeSessions(fixture.graph.db, ["worker", "absent"])).toEqual(["worker"]);
  });

  it("a cron-prompted session turns stale once its typed human turns pass two", () => {
    const db = fixture.graph.db;
    insertSession(db, { sessionId: "cron", seedPrompt: '[{"type":"text"}]' });
    insertRequest(db, { sessionId: "cron", ts: at(0) });
    for (const minute of [1, 2]) insertInbound(db, { sessionId: "cron", ts: at(minute), cause: "human_typed" });
    const before = staleEpisodeSessions(db);
    insertInbound(db, { sessionId: "cron", ts: at(3), cause: "human_typed" });

    expect(before).toEqual([]);
    expect(staleEpisodeSessions(db)).toEqual(["cron"]);
  });

  it("a human session with coordinator signals is stale under coordinator-v1 until its episodes are written", () => {
    const db = fixture.graph.db;
    insertSession(db, { sessionId: "coord" });
    insertRequest(db, { sessionId: "coord", ts: at(0) });
    insertSignal(db, { sessionId: "coord", ts: at(1), signal: "agent_spawn" });
    const before = staleEpisodeSessions(db);
    const written = writeEpisodes(fixture.graph, ["coord"]);

    expect(before).toEqual(["coord"]);
    expect(written.map((w) => w.heuristic)).toEqual(["coordinator-v1"]);
    expect(staleEpisodeSessions(db)).toEqual([]);
  });
});

describe("scoped request dedup", () => {
  let fixture: FixtureGraph;
  beforeEach(() => {
    fixture = createFixtureGraph();
  });
  afterEach(() => fixture.close());

  /** Workers with written episodes, then request copies whose first copy is always in "resumed". */
  function copiesAcrossSessions() {
    const db = fixture.graph.db;
    for (const sessionId of ["original", "resumed"]) {
      insertSession(db, { sessionId, startType: "sdk-cli" });
      insertOrigin(db, { sessionId, depth: 1, profile: "implementer" });
      insertInbound(db, { sessionId, ts: at(0), cause: "human_typed" });
      insertRequest(db, { sessionId, transcriptId: sessionId === "original" ? 1 : 2, ts: at(0) });
    }
    writeEpisodes(fixture.graph, ["original", "resumed"]);
    insertRequest(db, { sessionId: "resumed", transcriptId: 2, requestId: "shared", ts: at(5) });
    insertRequest(db, { sessionId: "original", transcriptId: 1, requestId: "shared", ts: at(6) });
    insertRequest(db, { sessionId: "resumed", transcriptId: 3, requestId: "tied", ts: at(7) });
    insertRequest(db, { sessionId: "original", transcriptId: 4, requestId: "tied", ts: at(7) });
  }

  function preparedSql(run: () => void): string[] {
    const prepare = vi.spyOn(fixture.graph.db, "prepare");
    run();
    const sql = prepare.mock.calls.map(([text]) => String(text));
    prepare.mockRestore();
    return sql;
  }

  function viewLifetimeMs(sessionId: string): number {
    const row = fixture.graph.db
      .prepare("SELECT MIN(ts) AS first, MAX(ts) AS last FROM request_dedup WHERE session_id = ? AND is_sidechain = 0")
      .get(sessionId) as { first: string; last: string };
    return Date.parse(row.last) - Date.parse(row.first);
  }

  it("a scoped staleness check prepares no request_dedup statement", () => {
    copiesAcrossSessions();

    const sql = preparedSql(() => staleEpisodeSessions(fixture.graph.db, ["original", "resumed"]));

    expect(sql.some((text) => /\bFROM request r\b/.test(text))).toBe(true);
    expect(sql.filter((text) => text.includes("request_dedup"))).toEqual([]);
  });

  it("reading session contexts prepares no request_dedup statement", () => {
    copiesAcrossSessions();

    const sql = preparedSql(() => readSessionContexts(fixture.graph.db, ["original", "resumed"]));

    expect(sql.some((text) => /\bFROM request r\b/.test(text))).toBe(true);
    expect(sql.filter((text) => text.includes("request_dedup"))).toEqual([]);
  });

  it("a scoped staleness check matches the full sweep when request copies span sessions", () => {
    copiesAcrossSessions();

    const full = staleEpisodeSessions(fixture.graph.db);

    expect(staleEpisodeSessions(fixture.graph.db, ["original", "resumed"])).toEqual(full);
    expect(full).toEqual(["resumed"]);
  });

  it("session lifetimes count only the copy request_dedup keeps", () => {
    copiesAcrossSessions();

    const contexts = readSessionContexts(fixture.graph.db, ["original", "resumed"]);

    expect(contexts.get("original")!.lifetimeMs).toBe(viewLifetimeMs("original"));
    expect(contexts.get("resumed")!.lifetimeMs).toBe(viewLifetimeMs("resumed"));
    expect(contexts.get("resumed")!.lifetimeMs).toBe(7 * 60_000);
  });
});

describe("readEpisodeInput", () => {
  let fixture: FixtureGraph;
  beforeEach(() => {
    fixture = createFixtureGraph();
  });
  afterEach(() => fixture.close());

  function viewRows(sessionId: string) {
    return fixture.graph.db
      .prepare(
        `SELECT byte_offset AS offset, ts, transcript_id AS transcriptId, context_tokens AS contextTokens, wake_cause AS wakeCause
         FROM request_dedup WHERE session_id = ? AND is_sidechain = 0 ORDER BY transcript_id, offset`,
      )
      .all(sessionId);
  }

  function inputRows(sessionId: string) {
    const rows = readEpisodeInput(fixture.graph.db, sessionId, false).requests;
    return [...rows].sort((a, b) => a.transcriptId - b.transcriptId || a.offset - b.offset);
  }

  it("episode input returns the same requests as request_dedup when copies span sessions", () => {
    const db = fixture.graph.db;
    insertRequest(db, { sessionId: "resumed", transcriptId: 2, requestId: "shared", ts: at(5) });
    insertRequest(db, { sessionId: "original", transcriptId: 1, requestId: "shared", ts: at(6) });
    insertRequest(db, { sessionId: "original", transcriptId: 3, requestId: "tied", ts: at(7) });
    insertRequest(db, { sessionId: "resumed", transcriptId: 4, requestId: "tied", ts: at(7) });
    insertRequest(db, { sessionId: "original", transcriptId: 1, requestId: "own", ts: at(8) });
    insertRequest(db, { sessionId: "original", transcriptId: 1, requestId: "side", ts: at(9) });
    db.prepare("UPDATE request SET is_sidechain = 1 WHERE request_id = 'side'").run();

    expect(inputRows("original")).toEqual(viewRows("original"));
    expect(inputRows("resumed")).toEqual(viewRows("resumed"));
    expect(inputRows("original").map((r) => r.transcriptId)).toEqual([1, 3]);
  });

  it("episode input for one session does not scan every request", () => {
    const plan = fixture.graph.db.prepare(`EXPLAIN QUERY PLAN ${EPISODE_REQUESTS_SQL}`).all({ sessionId: "s" }) as { detail: string }[];
    const details = plan.map((row) => row.detail);

    expect(details.filter((detail) => /^SCAN (r|request)\b/.test(detail))).toEqual([]);
    expect(details).toContainEqual(expect.stringMatching(/^SEARCH r USING INDEX idx_request_id/));
  });
});
