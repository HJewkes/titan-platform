import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCKED_FLOW_SOURCES } from "./blocked-flow.js";
import { EVENTS_TABLE_DDL, LAST_PROMPTS_SQL, SPAWNS_SQL, VERDICTS_SQL, eventsDbCommand, readLastPrompts, readSpawns, readVerdicts } from "./events-db.js";
import { LIVENESS_SOURCES } from "./liveness.js";

interface EventFixture {
  ts: string;
  kind: string;
  actor: string;
  target?: string;
  msgId?: string;
  ref?: string;
  body?: string;
  meta?: unknown;
}

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  db.exec(EVENTS_TABLE_DDL);
});
afterEach(() => db.close());

function seed(events: readonly EventFixture[]): void {
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, msg_id, ref, body, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const e of events) {
    const meta = typeof e.meta === "string" ? e.meta : e.meta === undefined ? null : JSON.stringify(e.meta);
    insert.run(Date.parse(e.ts), e.kind, e.actor, e.target ?? null, e.msgId ?? null, e.ref ?? null, e.body ?? null, meta);
  }
}

const HEAD = "a".repeat(40);
const verdict = (pr: string, head = HEAD) => `Verdict: MERGE\nPR: ${pr}\nHead: ${head}`;
const message = (ts: string, actor: string, target: string, body: string): EventFixture => ({ ts, kind: "message", actor, target, body });

describe("the printed events.db commands", () => {
  it("embed exactly the SQL each reader executes", () => {
    const pairs = [
      [BLOCKED_FLOW_SOURCES.verdicts.command, VERDICTS_SQL],
      [LIVENESS_SOURCES.spawns.command, SPAWNS_SQL],
      [LIVENESS_SOURCES.prompts.command, LAST_PROMPTS_SQL],
    ];

    for (const [command, sql] of pairs) {
      expect(command).toBe(eventsDbCommand(sql!));
      expect(command).toContain(` "${sql}"`);
    }
  });

  it("bind each named parameter once, to an epoch-millisecond placeholder", () => {
    expect(LIVENESS_SOURCES.prompts.command).toBe(`sqlite3 -readonly <events.db> ".parameter set @asOf <asOf epoch ms>" "${LAST_PROMPTS_SQL}"`);
    expect(BLOCKED_FLOW_SOURCES.verdicts.command).toContain(`".parameter set @since <since epoch ms>" ".parameter set @until <until epoch ms>"`);
    expect(LIVENESS_SOURCES.spawns.command).toBe(`sqlite3 -readonly <events.db> "${SPAWNS_SQL}"`);
  });
});

describe("readVerdicts", () => {
  it("reads verdict messages inside the window with their reviewer, and counts refused ones sent to the named seats", () => {
    seed([
      message("2026-09-12T07:59:59Z", "rev-1", "seat-a", verdict("acme/w#1")),
      message("2026-09-12T08:00:00Z", "rev-1", "seat-a", verdict("acme/w#2")),
      message("2026-09-12T09:00:00Z", "rev-2", "seat-a", verdict("acme/w#3", "abc1234")),
      message("2026-09-12T09:30:00Z", "rev-2", "seat-b", verdict("acme/w#4", "abc1234")),
      message("2026-09-12T10:00:00Z", "rev-1", "seat-a", "Status: DONE\nPR: acme/w#2"),
      message("2026-09-12T12:00:00Z", "rev-1", "seat-a", verdict("acme/w#5")),
    ]);

    const { verdicts, unparsed } = readVerdicts(db, { since: "2026-09-12T08:00:00Z", until: "2026-09-12T12:00:00Z" }, ["seat-a"]);

    expect(verdicts).toEqual([{ verdict: "MERGE", repo: "acme/w", pr: 2, head: HEAD, eventId: 2, at: "2026-09-12T08:00:00.000Z", seat: "seat-a", reviewer: "rev-1" }]);
    expect(unparsed).toBe(1);
  });

  it("reads every verdict when the window is open", () => {
    seed([message("2026-01-01T00:00:00Z", "rev-1", "seat-a", verdict("acme/w#1")), message("2099-01-01T00:00:00Z", "rev-1", "seat-a", verdict("acme/w#2"))]);

    expect(readVerdicts(db, {}).verdicts.map((v) => v.pr)).toEqual([1, 2]);
  });
});

describe("readSpawns", () => {
  it("reads each spawn with an agent id, and a null profile where meta is not JSON", () => {
    seed([
      { ts: "2026-09-12T07:00:00Z", kind: "agent_spawned", actor: "seat-a", target: "impl-1", msgId: "a1", meta: { profile: "implementer" } },
      { ts: "2026-09-12T07:01:00Z", kind: "agent_spawned", actor: "seat-a", target: "impl-2", meta: { profile: "implementer" } },
      { ts: "2026-09-12T07:02:00Z", kind: "agent_spawned", actor: "seat-a", msgId: "a3", meta: "not json" },
    ]);

    expect(readSpawns(db)).toEqual([
      { eventId: 1, agentId: "a1", name: "impl-1", profile: "implementer" },
      { eventId: 3, agentId: "a3", name: "", profile: null },
    ]);
  });
});

const PROMPT_EVENTS: EventFixture[] = [
  { ts: "2026-09-12T10:00:00Z", kind: "approval_request", actor: "rev-1", target: "human", msgId: "p1", meta: { tool_name: "Bash" } },
  { ts: "2026-09-12T10:30:00Z", kind: "approval_request", actor: "rev-2", target: "human", msgId: "p2", meta: { tool_name: "Edit" } },
  { ts: "2026-09-12T10:31:00Z", kind: "resolution", actor: "rev-2", ref: "p2", meta: "withdrawn" },
  { ts: "2026-09-12T10:40:00Z", kind: "approval_request", actor: "impl-1", target: "human", msgId: "p3", meta: "not json" },
  { ts: "2026-09-12T10:45:00Z", kind: "approval_request", actor: "rev-3", target: "human", msgId: "p4" },
  { ts: "2026-09-12T10:46:00Z", kind: "message", actor: "rev-3", target: "seat-a" },
  { ts: "2026-09-12T10:50:00Z", kind: "approval_request", actor: "rev-6", target: "human", msgId: "p6", meta: { tool_name: "Bash" } },
  { ts: "2026-09-12T10:55:00Z", kind: "agent_retired", actor: "human", target: "rev-6" },
  { ts: "2026-09-12T13:00:00Z", kind: "message", actor: "rev-1", target: "seat-a" },
];

describe("readLastPrompts", () => {
  it("keeps each actor whose last event before asOf is a prompt, with its resolution and any later retirement", () => {
    seed(PROMPT_EVENTS);

    const prompts = readLastPrompts(db, "2026-09-12T12:00:00Z");

    expect(prompts).toEqual([
      { eventId: 1, at: "2026-09-12T10:00:00.000Z", actor: "rev-1", kind: "approval_request", tool: "Bash", resolutionEventId: null, endEventId: null },
      { eventId: 2, at: "2026-09-12T10:30:00.000Z", actor: "rev-2", kind: "approval_request", tool: "Edit", resolutionEventId: 3, endEventId: null },
      { eventId: 4, at: "2026-09-12T10:40:00.000Z", actor: "impl-1", kind: "approval_request", tool: null, resolutionEventId: null, endEventId: null },
      { eventId: 7, at: "2026-09-12T10:50:00.000Z", actor: "rev-6", kind: "approval_request", tool: "Bash", resolutionEventId: null, endEventId: 8 },
    ]);
  });

  it("ignores events at or after asOf", () => {
    seed(PROMPT_EVENTS);

    expect(readLastPrompts(db, "2026-09-12T10:31:00Z").map((p) => [p.actor, p.resolutionEventId])).toEqual([
      ["rev-1", null],
      ["rev-2", null],
    ]);
  });
});
