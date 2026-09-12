import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionRecord, ExecutionTransition } from "@titan-design/agent-protocol";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { executionLedgerMigration } from "./migration.js";
import { SqliteExecutionLedger } from "./sqlite-execution-ledger.js";

const start = "2026-09-11T00:00:00.000Z";
const until = "2026-09-11T00:00:10.000Z";
const fence = { supervisorId: "owner-a", generation: 1 };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function prepare(executionId = "execution", requestKey = "request"): ExecutionTransition<string> {
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
      expect(ledger.apply({ ...prepare(), harness: "claude-code" } as ExecutionTransition<string>)).toMatchObject({ ok: false, kind: "event_conflict" });
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
      expect(ledger.apply({ kind: "finish", executionId: "execution", eventId: "invalid", expectedRevision: record.revision, occurredAt: start,
        fence, terminal: { outcome: "succeeded", result: new Error("opaque") as unknown as string } })).toMatchObject({ ok: false, kind: "invalid_transition" });
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
    expect(ledger.apply(Object.fromEntries(Object.entries(event).reverse()) as ExecutionTransition<string>)).toMatchObject({ ok: true, applied: false });
  } finally { db.close(); }
});

it("returns invalid_transition for malformed JSON payloads without partial writes", () => {
  const { db, ledger } = setup();
  try {
    const malformedPrepare = { ...prepare(), owner: undefined } as unknown as ExecutionTransition<string>;
    expect(ledger.apply(malformedPrepare)).toMatchObject({ ok: false, kind: "invalid_transition" });
    expect(ledger.get("execution")).toBeUndefined();
    const record = applied(ledger, prepare());
    for (const event of [
      { kind: "claim_owner", owner: undefined },
      { kind: "renew_owner", fence, leaseUntil: undefined },
      { kind: "finish", fence, terminal: null },
    ]) {
      expect(ledger.apply({ ...event, executionId: "execution", eventId: event.kind, expectedRevision: record.revision,
        occurredAt: start } as unknown as ExecutionTransition<string>)).toMatchObject({ ok: false, kind: "invalid_transition" });
    }
    expect(ledger.apply(null as unknown as ExecutionTransition<string>)).toMatchObject({ ok: false, kind: "invalid_transition" });
    expect(ledger.get("execution")).toEqual(record);
    expect(ledger.events("execution")).toHaveLength(1);
  } finally { db.close(); }
});
