import { describe, expect, it } from "vitest";
import type { ExecutionTransition } from "@titan-design/agent-protocol";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { executionLedgerMigration } from "./migration.js";
import { SqliteExecutionLedger } from "./sqlite-execution-ledger.js";

const start = "2026-09-11T00:00:00.000Z";
const until = "2026-09-11T00:00:10.000Z";
const fence = { supervisorId: "owner-a", generation: 1 };
const prepare: ExecutionTransition<string> = {
  kind: "prepare", executionId: "execution", eventId: "prepare", expectedRevision: 0, occurredAt: start,
  execution: { executionId: "execution" }, harness: "codex", requestKey: "request", target: { kind: "fresh", namespace: "host" },
  owner: { ...fence, leaseUntil: until },
};

function preparedLedger() {
  const db = openDatabase(":memory:");
  runMigrations(db, [executionLedgerMigration(1)]);
  const ledger = new SqliteExecutionLedger<string>(db, { now: () => start });
  expect(ledger.apply(prepare)).toMatchObject({ ok: true });
  return { db, ledger };
}

function storedRecord(db: ReturnType<typeof openDatabase>): Record<string, unknown> {
  const row: unknown = db.prepare("SELECT record FROM agent_execution WHERE execution_id = 'execution'").get();
  if (typeof row !== "object" || row === null || !("record" in row) || typeof row.record !== "string") throw new Error("no stored row");
  const parsed: unknown = JSON.parse(row.record);
  if (typeof parsed !== "object" || parsed === null) throw new Error("stored record is not an object");
  return Object.fromEntries(Object.entries(parsed));
}

function overwriteRecord(db: ReturnType<typeof openDatabase>, record: unknown): void {
  db.prepare("UPDATE agent_execution SET record = ? WHERE execution_id = 'execution'").run(typeof record === "string" ? record : JSON.stringify(record));
}

describe("stored ledger rows", () => {
  it("rejects a snapshot whose phase is not a known phase, naming the field", () => {
    const { db, ledger } = preparedLedger();
    try {
      overwriteRecord(db, { ...storedRecord(db), phase: "levitating" });
      expect(() => ledger.get("execution")).toThrow(/stored execution record is malformed[\s\S]*phase/);
    } finally { db.close(); }
  });

  it("rejects a snapshot missing a required field", () => {
    const { db, ledger } = preparedLedger();
    try {
      overwriteRecord(db, Object.fromEntries(Object.entries(storedRecord(db)).filter(([key]) => key !== "requestKey")));
      expect(() => ledger.get("execution")).toThrow(/requestKey/);
    } finally { db.close(); }
  });

  it("rejects a snapshot that is not valid JSON", () => {
    const { db, ledger } = preparedLedger();
    try {
      overwriteRecord(db, "{not json");
      expect(() => ledger.get("execution")).toThrow(/not valid JSON/);
    } finally { db.close(); }
  });

  it("rejects a stored event with an unknown kind", () => {
    const { db, ledger } = preparedLedger();
    try {
      db.prepare("UPDATE agent_execution_event SET transition = ? WHERE execution_id = 'execution'")
        .run(JSON.stringify({ ...prepare, kind: "teleport" }));
      expect(() => ledger.events("execution")).toThrow(/stored execution transition is malformed/);
    } finally { db.close(); }
  });

  it("keeps unknown keys a newer writer stored on the snapshot", () => {
    const { db, ledger } = preparedLedger();
    try {
      overwriteRecord(db, { ...storedRecord(db), futureField: { nested: true } });
      expect(ledger.get("execution")).toMatchObject({ futureField: { nested: true }, phase: "prepared" });
    } finally { db.close(); }
  });

  it("lists the good recoverable executions and logs one line for a malformed row", () => {
    const { db, ledger } = preparedLedger();
    const lines: string[] = [];
    try {
      expect(ledger.apply({ ...prepare, executionId: "second", eventId: "prepare-2", requestKey: "request-2", execution: { executionId: "second" } })).toMatchObject({ ok: true });
      overwriteRecord(db, { ...storedRecord(db), phase: "levitating" });
      const tolerant = new SqliteExecutionLedger<string>(db, { now: () => start, warn: line => lines.push(line) });
      expect(tolerant.listRecoverable().map(record => record.execution.executionId)).toEqual(["second"]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/skipping unreadable execution execution during recovery/);
    } finally { db.close(); }
  });
});
