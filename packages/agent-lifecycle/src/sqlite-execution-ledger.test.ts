import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXECUTION_PHASES, TERMINAL_EXECUTION_PHASES, isTerminalExecutionPhase } from "@titan-design/agent-protocol";
import type { ExecutionRecord, ExecutionTransition } from "@titan-design/agent-protocol";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import { executionLedgerMigration } from "./migration.js";
import { SqliteExecutionLedger, recoverableSql } from "./sqlite-execution-ledger.js";

const start = "2026-09-11T00:00:00.000Z";
const until = "2026-09-11T00:00:10.000Z";
const fence = { supervisorId: "owner-a", generation: 1 };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
type PrepareTransition = Extract<ExecutionTransition<string>, { kind: "prepare" }>;
function prepare(executionId = "execution", requestKey = "request"): PrepareTransition {
  return { kind: "prepare", executionId, eventId: "prepare", expectedRevision: 0, occurredAt: start,
    execution: { executionId }, harness: "codex", requestKey, target: { kind: "fresh", namespace: "host" },
    agent: { agentId: "agent" }, owner: { ...fence, leaseUntil: until } };
}
function setup(file = ":memory:") {
  const db = openDatabase(file);
  runMigrations(db, [executionLedgerMigration(1)]);
  let now = start;
  const ledger = new SqliteExecutionLedger<string>(db, { now: () => now });
  return { db, ledger, setTime: (value: string) => { now = value; } };
}
function applied(ledger: SqliteExecutionLedger<string>, event: ExecutionTransition<string>): ExecutionRecord<string> {
  const result = ledger.apply(event);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.record;
}

describe("execution ledger", () => {
  it("replays identical events before revision checks and rejects conflicting event reuse", () => {
    const { db, ledger } = setup();
    try {
      const first = applied(ledger, prepare());
      expect(first.phase).toBe("prepared");
      applied(ledger, { kind: "begin_dispatch", executionId: "execution", eventId: "begin", expectedRevision: first.revision, occurredAt: start, fence });
      expect(ledger.apply(prepare())).toMatchObject({ ok: true, applied: false, record: { phase: "prepared" } });
      expect(ledger.apply({ ...prepare(), harness: "claude-code" })).toMatchObject({ ok: false, kind: "event_conflict" });
      expect(ledger.get("execution")?.phase).toBe("dispatching");
      expect(ledger.events("execution")).toHaveLength(2);
    } finally { db.close(); }
  });

  it("rolls back rejected transitions and prevents request-key duplication", () => {
    const { db, ledger } = setup();
    try {
      const record = applied(ledger, prepare());
      expect(ledger.apply(prepare("second"))).toMatchObject({ ok: false, kind: "event_conflict" });
      expect(ledger.get("second")).toBeUndefined();
      expect(ledger.apply({ kind: "begin_dispatch", executionId: "execution", eventId: "wrong-revision", expectedRevision: 99, occurredAt: start, fence })).toMatchObject({ ok: false, kind: "revision_conflict" });
      expect(ledger.get("execution")).toEqual(record);
      expect(ledger.events("execution")).toHaveLength(1);
    } finally { db.close(); }
  });

  it("fences expired and replaced owners even if a callback backdates its event", () => {
    const { db, ledger, setTime } = setup();
    try {
      const record = applied(ledger, prepare());
      setTime("2026-09-11T00:00:11.000Z");
      const stale: ExecutionTransition<string> = { kind: "begin_dispatch", executionId: "execution", eventId: "stale", expectedRevision: record.revision, occurredAt: start, fence };
      expect(ledger.apply(stale)).toMatchObject({ ok: false, kind: "ownership_lost" });
      const claimed = applied(ledger, { kind: "claim_owner", executionId: "execution", eventId: "claim", expectedRevision: record.revision,
        occurredAt: "2026-09-11T00:00:11.000Z", owner: { supervisorId: "owner-b", generation: 2, leaseUntil: "2026-09-11T00:00:20.000Z" } });
      expect(ledger.apply({ ...stale, expectedRevision: claimed.revision, occurredAt: "2026-09-11T00:00:11.000Z" })).toMatchObject({ ok: false, kind: "ownership_lost" });
      expect(ledger.get("execution")?.ownerGeneration).toBe(2);
    } finally { db.close(); }
  });

  it("preserves terminal receipts and excludes terminal executions from recovery scans", () => {
    const { db, ledger } = setup();
    try {
      const record = applied(ledger, prepare());
      const finish: ExecutionTransition<string> = { kind: "finish", executionId: "execution", eventId: "finish", expectedRevision: record.revision,
        occurredAt: start, fence, terminal: { outcome: "cancelled", reason: "cancelled before dispatch" } };
      const terminal = applied(ledger, finish);
      expect(terminal.owner).toBeUndefined();
      expect(ledger.listRecoverable()).toEqual([]);
      expect(ledger.apply(finish)).toMatchObject({ ok: true, applied: false });
      expect(ledger.apply({ ...finish, eventId: "another", expectedRevision: terminal.revision }).ok).toBe(false);
      expect(ledger.get("execution")).toEqual(terminal);
    } finally { db.close(); }
  });

  it("never lists an ended execution as recoverable", () => {
    const { db, ledger } = setup();
    try {
      const record = applied(ledger, prepare());
      const dispatched = applied(ledger, { kind: "begin_dispatch", executionId: "execution", eventId: "begin", expectedRevision: record.revision, occurredAt: start, fence });
      applied(ledger, { kind: "finish", executionId: "execution", eventId: "ended", expectedRevision: dispatched.revision, occurredAt: start, fence,
        terminal: { outcome: "ended", evidence: "process gone" } });
      expect(ledger.listRecoverable()).toEqual([]);
    } finally { db.close(); }
  });

  it("persists snapshots and ordered receipts across reopen and concurrent owners", () => {
    const dir = mkdtempSync(join(tmpdir(), "execution-ledger-")); dirs.push(dir);
    const file = join(dir, "ledger.sqlite");
    const first = setup(file);
    const record = applied(first.ledger, prepare());
    const second = setup(file);
    try {
      applied(second.ledger, { kind: "begin_dispatch", executionId: "execution", eventId: "begin", expectedRevision: record.revision, occurredAt: start, fence });
      expect(first.ledger.apply({ kind: "release_owner", executionId: "execution", eventId: "release", expectedRevision: record.revision, occurredAt: start, fence })).toMatchObject({ ok: false, kind: "revision_conflict" });
      expect(first.ledger.findByRequestKey("request")?.phase).toBe("dispatching");
      expect(second.ledger.events("execution").map(event => event.kind)).toEqual(["prepare", "begin_dispatch"]);
    } finally { first.db.close(); second.db.close(); }
  });

  it("rejects non-JSON terminal values and future events without writing partial state", () => {
    const { db, ledger } = setup();
    try {
      const record = applied(ledger, prepare());
      const opaqueLedger = new SqliteExecutionLedger<unknown>(db, { now: () => start });
      expect(opaqueLedger.apply({ kind: "finish", executionId: "execution", eventId: "invalid", expectedRevision: record.revision, occurredAt: start,
        fence, terminal: { outcome: "succeeded", result: new Error("opaque") } })).toMatchObject({ ok: false, kind: "invalid_transition" });
      expect(ledger.apply({ kind: "begin_dispatch", executionId: "execution", eventId: "future", expectedRevision: record.revision,
        occurredAt: "2026-09-11T00:00:01.000Z", fence })).toMatchObject({ ok: false, kind: "invalid_transition" });
      expect(ledger.events("execution")).toHaveLength(1);
      expect(ledger.get("execution")).toEqual(record);
    } finally { db.close(); }
  });
});

it("rolls the snapshot back if the event receipt cannot commit", () => {
  const { db, ledger } = setup();
  try {
    const record = applied(ledger, prepare());
    db.exec(`CREATE TRIGGER reject_begin BEFORE INSERT ON agent_execution_event
      WHEN NEW.event_id = 'begin' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;`);
    expect(() => ledger.apply({ kind: "begin_dispatch", executionId: "execution", eventId: "begin",
      expectedRevision: record.revision, occurredAt: start, fence })).toThrow(/injected receipt failure/);
    expect(ledger.get("execution")).toEqual(record);
    expect(ledger.events("execution")).toHaveLength(1);
  } finally { db.close(); }
});

it("treats reordered JSON event fields as the same idempotency receipt", () => {
  const { db, ledger } = setup();
  try {
    const event = prepare();
    applied(ledger, event);
    const reordered: ExecutionTransition<string> = { owner: { ...fence, leaseUntil: until }, agent: { agentId: "agent" }, target: { kind: "fresh", namespace: "host" },
      requestKey: "request", harness: "codex", execution: { executionId: "execution" }, occurredAt: start, expectedRevision: 0, eventId: "prepare",
      executionId: "execution", kind: "prepare" };
    expect(Object.keys(reordered)).toEqual(Object.keys(event).reverse());
    expect(ledger.apply(reordered)).toMatchObject({ ok: true, applied: false });
  } finally { db.close(); }
});

it("returns invalid_transition for malformed JSON payloads without partial writes", () => {
  const { db, ledger } = setup();
  try {
    const malformedPrepare = partialFake<PrepareTransition>({ ...prepare(), owner: undefined });
    expect(ledger.apply(malformedPrepare)).toMatchObject({ ok: false, kind: "invalid_transition" });
    expect(ledger.get("execution")).toBeUndefined();
    const record = applied(ledger, prepare());
    const base = { executionId: "execution", expectedRevision: record.revision, occurredAt: start };
    for (const event of [
      partialFake<ExecutionTransition<string>>({ ...base, kind: "claim_owner", eventId: "claim_owner" }),
      partialFake<ExecutionTransition<string>>({ ...base, kind: "renew_owner", eventId: "renew_owner", fence }),
      partialFake<ExecutionTransition<string>>({ ...base, kind: "finish", eventId: "finish", fence }),
    ]) {
      expect(ledger.apply(event)).toMatchObject({ ok: false, kind: "invalid_transition" });
    }
    expect(Reflect.apply(ledger.apply, ledger, [null])).toMatchObject({ ok: false, kind: "invalid_transition" });
    expect(ledger.get("execution")).toEqual(record);
    expect(ledger.events("execution")).toHaveLength(1);
  } finally { db.close(); }
});

describe("listRecoverable query", () => {
  const phases = EXECUTION_PHASES;
  const notInSql = (snapshot: string) => `SELECT record FROM ${snapshot}
    WHERE phase NOT IN (${TERMINAL_EXECUTION_PHASES.map(phase => `'${phase}'`).join(",")})
    ORDER BY prepared_at,execution_id LIMIT ?`;

  function column(rows: unknown[], key: "detail" | "record"): string[] {
    return rows.map(row => {
      const value = typeof row === "object" && row !== null ? Reflect.get(row, key) : undefined;
      if (typeof value !== "string") throw new TypeError(`row has no ${key}`);
      return value;
    });
  }
  const oldRecords = (db: ReturnType<typeof setup>["db"], limit: number) =>
    column(db.prepare(notInSql("agent_execution")).all(limit), "record").map(record => JSON.parse(record));

  function storedRecord(id: string, phase: string): Record<string, unknown> {
    return { execution: { executionId: id }, harness: "codex", requestKey: `key-${id}`, target: { kind: "fresh", namespace: "host" },
      phase, revision: 1, ownerGeneration: 0, preparedAt: start, lastObservedAt: start };
  }

  function seed(db: ReturnType<typeof setup>["db"], perPhase: number): void {
    const insert = db.prepare(`INSERT INTO agent_execution
      (execution_id,request_key,phase,revision,owner_id,owner_generation,lease_until,prepared_at,updated_at,record)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let n = 0;
    for (const phase of phases) {
      const count = isTerminalExecutionPhase(phase) ? perPhase : 3;
      for (let i = 0; i < count; i++, n++) {
        const id = `exec-${String(n).padStart(5, "0")}`;
        insert.run(id, `key-${id}`, phase, 1, null, 0, null, `2026-09-11T00:${String(n % 60).padStart(2, "0")}:00.000Z`, start, JSON.stringify(storedRecord(id, phase)));
      }
    }
  }

  it("plans through the phase index instead of scanning the table", () => {
    const { db } = setup();
    try {
      seed(db, 200);
      const details = column(db.prepare(`EXPLAIN QUERY PLAN ${recoverableSql("agent_execution")}`).all(10), "detail").join("\n");
      expect(details).not.toContain("SCAN agent_execution");
      expect(details).toContain("agent_execution_phase");
    } finally { db.close(); }
  });

  it("returns what the NOT IN query returned, with and without a limit", () => {
    const { db, ledger } = setup();
    try {
      seed(db, 20);
      for (const limit of [undefined, 1, 5, 1000]) {
        const expected = oldRecords(db, limit ?? 100);
        expect(ledger.listRecoverable(limit)).toEqual(expected);
      }
      expect(ledger.listRecoverable(1000)).toHaveLength(3 * phases.filter(phase => !isTerminalExecutionPhase(phase)).length);
    } finally { db.close(); }
  });

  it("returns the same rows as NOT IN for each phase on its own", () => {
    for (const phase of phases) {
      const { db, ledger } = setup();
      try {
        db.prepare(`INSERT INTO agent_execution (execution_id,request_key,phase,revision,owner_id,owner_generation,lease_until,prepared_at,updated_at,record)
          VALUES ('only','only',?,1,NULL,0,NULL,?,?,?)`).run(phase, start, start, JSON.stringify(storedRecord("only", phase)));
        const expected = oldRecords(db, 100);
        expect(ledger.listRecoverable()).toEqual(expected);
        expect(ledger.listRecoverable()).toHaveLength(isTerminalExecutionPhase(phase) ? 0 : 1);
      } finally { db.close(); }
    }
  });
});
