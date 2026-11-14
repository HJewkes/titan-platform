import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { agentChatHome, openEventsDb, readLedgerPicks, readOperatorSpawns, readShadowDays } from "./compare-read.js";

const EVENTS_DDL = "CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT, target TEXT, msg_id TEXT, ref TEXT, body TEXT, meta TEXT)";

const T0 = Date.parse("2026-03-04T10:00:00Z");

let opened: Db[] = [];

afterEach(() => {
  for (const db of opened) db.close();
  opened = [];
});

function memoryEvents(rows: { ts: number; kind?: string; actor: string; target?: string; meta: Record<string, unknown> }[]): Db {
  const db = openDatabase(":memory:", { foreignKeys: false });
  db.exec(EVENTS_DDL);
  const insert = db.prepare("INSERT INTO events (ts, kind, actor, target, meta) VALUES (?, ?, ?, ?, ?)");
  for (const row of rows) insert.run(row.ts, row.kind ?? "agent_spawned", row.actor, row.target ?? null, JSON.stringify(row.meta));
  opened.push(db);
  return db;
}

const scratch = (): string => mkdtempSync(join(tmpdir(), "shadow-compare-read-"));

describe("readOperatorSpawns", () => {
  it("keys on the actor column, so a row naming the seat only in meta.launched_by is ignored", () => {
    const db = memoryEvents([
      { ts: T0, actor: "op-seat", meta: { task: "ZZ-1", role: "worker", name: "ops-zz1" } },
      { ts: T0 + 1, actor: "other-seat", meta: { task: "ZZ-2", launched_by: "op-seat" } },
    ]);

    expect(readOperatorSpawns(db, "op-seat", T0 - 1, T0 + 10).map((spawn) => spawn.task)).toEqual(["ZZ-1"]);
  });

  it("reads only agent_spawned rows inside the window, with role, briefing and name", () => {
    const db = memoryEvents([
      { ts: T0 - 5, actor: "op-seat", meta: { task: "ZZ-0" } },
      { ts: T0, actor: "op-seat", meta: { role: "worker", briefing: "zeta", name: "ops-zz7" } },
      { ts: T0 + 1, kind: "agent_resumed", actor: "op-seat", meta: { task: "ZZ-3" } },
      { ts: T0 + 2, actor: "op-seat", target: "ops-zz8", meta: { briefing: "" } },
    ]);

    expect(readOperatorSpawns(db, "op-seat", T0, T0 + 10)).toEqual([
      { ts: T0, name: "ops-zz7", task: null, role: "worker", briefing: "zeta" },
      { ts: T0 + 2, name: "ops-zz8", task: null, role: null, briefing: null },
    ]);
  });
});

describe("openEventsDb", () => {
  it("opens the database read-only, so an INSERT throws and the rows stay as they were", () => {
    const file = join(scratch(), "events.db");
    const seed = openDatabase(file, { foreignKeys: false });
    seed.exec(EVENTS_DDL);
    seed.close();

    const db = openEventsDb(file);
    opened.push(db);

    expect(() => db.prepare("INSERT INTO events (ts, kind, actor) VALUES (1, 'agent_spawned', 'x')").run()).toThrow(/readonly/i);
    expect(db.prepare("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
  });
});

describe("readShadowDays", () => {
  it("reads the day and the day before, keeps unknown fields and codes, and counts lines it cannot parse", () => {
    const dir = scratch();
    const wake = { v: 1, kind: "wake", wake: "w1", at: "2026-03-04T09:00:00Z" };
    const future = { v: 1, kind: "refused", wake: "w1", at: "2026-03-04T09:00:00Z", task: "zeta/ZZ-1", stage: "stop", codes: ["some-new-code"], next: "planner-once" };
    writeFileSync(join(dir, "2026-03-04.jsonl"), [JSON.stringify(wake), JSON.stringify(future), "not json", JSON.stringify({ kind: "wake" })].join("\n"));
    writeFileSync(join(dir, "2026-03-03.jsonl"), `${JSON.stringify({ ...wake, wake: "w0", at: "2026-03-03T23:30:00Z" })}\n`);

    const read = readShadowDays(dir, "2026-03-04");

    expect(read.day.rows).toHaveLength(2);
    expect(read.day.rows[1]).toMatchObject({ codes: ["some-new-code"], next: "planner-once" });
    expect(read.day.badLines).toBe(2);
    expect(read.prior.rows.map((row) => row.wake)).toEqual(["w0"]);
  });

  it("an absent day reads as no rows", () => {
    expect(readShadowDays(scratch(), "2026-03-04")).toEqual({ day: { rows: [], badLines: 0 }, prior: { rows: [], badLines: 0 } });
  });
});

describe("readLedgerPicks", () => {
  const claim = (taskId: string, phase: string, seat?: string) => ({ taskId, initiative: "zeta", spawnedAt: "2026-03-04T08:00:00Z", phase, phaseAt: "2026-03-04T08:00:00Z", ...(seat && { seat }) });

  it("takes lane claims of the operator's seat as canonical keys", () => {
    const file = join(scratch(), "burndown.json");
    writeFileSync(file, JSON.stringify({ version: 1, claims: [claim("ZZ-1", "implementing", "op-seat"), claim("ZZ-2", "done", "op-seat"), claim("ZZ-3", "implementing", "other")] }));

    expect(readLedgerPicks(file, "op-seat")).toEqual([{ task: "zeta/ZZ-1", at: Date.parse("2026-03-04T08:00:00Z") }]);
  });

  it("an absent ledger reads as no picks", () => {
    expect(readLedgerPicks(join(scratch(), "none.json"), "op-seat")).toEqual([]);
  });
});

describe("agentChatHome", () => {
  it("prefers AGENT_CHAT_HOME, else the home's .agent-chat", () => {
    expect(agentChatHome({ AGENT_CHAT_HOME: "/x/chat", HOME: "/x" })).toBe("/x/chat");
    expect(agentChatHome({ HOME: "/x" })).toBe(join("/x", ".agent-chat"));
  });
});
