import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryGateStore } from "./memory-store.js";
import { SqliteGateStore, gateEvidenceMigration, gateMigration, gateResolverMigration, gateRuleMigration } from "./sqlite-store.js";
import { GateEvidenceInvalid, GateResolverRefused, GateStoreSchemaOutdated, type GateEvidencePolicy, type GateResolver, type GateStore } from "./types.js";

const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-fixture", channel: "test-cli" };
const OWNER: GateResolver = { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" };
const EVIDENCE = { kind: "pr-gone", gateId: "run-1/approve-merge", state: "merged" };

/** Admits a coordinator only when the evidence names this gate and says its PR is gone. */
const goneOnly: GateEvidencePolicy = (gate, resolver, _payload, evidence) =>
  resolver.class === "coordinator" && evidence.gateId === gate.id && evidence.state === "merged";

const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

function tempDb(migrations = [gateMigration(1), gateResolverMigration(2), gateRuleMigration(3), gateEvidenceMigration(4)]) {
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-evidence-"));
  const db = openDatabase(path.join(dir, "gates.sqlite3"));
  runMigrations(db, migrations);
  disposers.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const memory = (evidencePolicy?: GateEvidencePolicy): GateStore => new MemoryGateStore({ evidencePolicy });
const sqlite = (evidencePolicy?: GateEvidencePolicy): GateStore => new SqliteGateStore(tempDb(), { migrate: false, evidencePolicy });

describe.each([
  ["MemoryGateStore", memory],
  ["SqliteGateStore", sqlite],
])("%s evidence policy", (_name, make) => {
  const pending = (policy: GateEvidencePolicy | undefined = goneOnly) => {
    const store = make(policy);
    store.create({ id: "run-1/approve-merge", prompt: "merge?" });
    return store;
  };

  it("admits a coordinator whose evidence the policy accepts and stores the evidence on the row", () => {
    const store = pending();

    store.resolve("run-1/approve-merge", { decision: "abandon" }, COORDINATOR, EVIDENCE);

    expect(store.get("run-1/approve-merge")).toMatchObject({ status: "resolved", resolvedBy: COORDINATOR, resolvedEvidence: EVIDENCE });
  });

  it("refuses a coordinator that gives no evidence and leaves the gate pending", () => {
    const store = pending();

    expect(() => store.resolve("run-1/approve-merge", { decision: "abandon" }, COORDINATOR)).toThrow("actor class coordinator may not resolve a gate");
    expect(store.get("run-1/approve-merge")?.status).toBe("pending");
  });

  it("refuses a coordinator whose evidence the policy rejects", () => {
    const store = pending();

    expect(() => store.resolve("run-1/approve-merge", { decision: "abandon" }, COORDINATOR, { ...EVIDENCE, state: "open" })).toThrow(GateResolverRefused);
  });

  it("refuses evidence that names another gate", () => {
    const store = pending();

    expect(() => store.resolve("run-1/approve-merge", { decision: "abandon" }, COORDINATOR, { ...EVIDENCE, gateId: "run-2/approve-merge" })).toThrow(GateResolverRefused);
  });

  it("refuses evidence when the store has no evidence policy", () => {
    const store = make();
    store.create({ id: "run-1/approve-merge", prompt: "merge?" });

    expect(() => store.resolve("run-1/approve-merge", { decision: "abandon" }, COORDINATOR, EVIDENCE)).toThrow(GateResolverRefused);
    expect(store.get("run-1/approve-merge")?.status).toBe("pending");
  });

  it("fails closed when the policy throws or answers a truthy non-boolean", () => {
    const throwing = pending(() => {
      throw new Error("bug");
    });
    const truthy = pending((() => "yes") as unknown as GateEvidencePolicy);

    expect(() => throwing.resolve("run-1/approve-merge", {}, COORDINATOR, EVIDENCE)).toThrow(GateResolverRefused);
    expect(() => truthy.resolve("run-1/approve-merge", {}, COORDINATOR, EVIDENCE)).toThrow(GateResolverRefused);
  });

  it("refuses an admitted coordinator that does not name itself", () => {
    const store = pending();

    expect(() => store.resolve("run-1/approve-merge", {}, { ...COORDINATOR, id: " " }, EVIDENCE)).toThrow("must name itself");
  });

  it("never lets evidence admit an automation class the policy does not name", () => {
    const store = pending();

    expect(() => store.resolve("run-1/approve-merge", {}, { class: "automation", id: "bot", channel: "test-cli" }, EVIDENCE)).toThrow(GateResolverRefused);
  });

  it("refuses evidence that is not a JSON object before reading the gate", () => {
    const store = pending();

    expect(() => store.resolve("run-1/approve-merge", {}, COORDINATOR, ["merged"] as unknown as Record<string, unknown>)).toThrow(GateEvidenceInvalid);
    expect(() => store.resolve("run-1/approve-merge", {}, COORDINATOR, { big: "x".repeat(20_000) })).toThrow(GateEvidenceInvalid);
  });

  it("checks and stores a copy, so a caller mutating the evidence afterwards changes neither", () => {
    const store = pending();
    const evidence = { ...EVIDENCE, runs: [1, 2] };

    store.resolve("run-1/approve-merge", {}, COORDINATOR, evidence);
    evidence.runs.push(3);

    expect(store.get("run-1/approve-merge")?.resolvedEvidence).toEqual({ ...EVIDENCE, runs: [1, 2] });
  });

  it("stores evidence an owner gives without consulting the policy", () => {
    const store = pending(() => false);

    store.resolve("run-1/approve-merge", { decision: "merge" }, OWNER, EVIDENCE);

    expect(store.get("run-1/approve-merge")?.resolvedEvidence).toEqual(EVIDENCE);
  });

  it("leaves resolvedEvidence unset on a resolve that gives none", () => {
    const store = pending();

    store.resolve("run-1/approve-merge", { decision: "merge" }, OWNER);

    expect(store.get("run-1/approve-merge")?.resolvedEvidence).toBeUndefined();
  });

  it("still applies the gate's rule after the evidence policy admits", () => {
    const store = make(goneOnly);
    store.create({ id: "run-1/approve-merge", prompt: "merge?", rule: { table: "t", version: "1", ruleId: "r", resolvers: ["owner-terminal"] } });

    expect(() => store.resolve("run-1/approve-merge", {}, COORDINATOR, EVIDENCE)).toThrow("rule r does not let coordinator resolve this gate");
  });
});

describe("gateEvidenceMigration", () => {
  it("is idempotent and leaves a gate resolved before it without evidence", () => {
    const db = tempDb([gateMigration(1), gateResolverMigration(2)]);
    const before = new SqliteGateStore(db, { migrate: false });
    before.create({ id: "old", prompt: "legacy?" });
    before.resolve("old", "ok", OWNER);
    const migration = gateEvidenceMigration(4);

    migration.up(db);
    migration.up(db);

    expect(new SqliteGateStore(db, { migrate: false }).get("old")).toMatchObject({ status: "resolved", resolvedEvidence: undefined });
  });

  it("a store on a table without the column refuses an evidence resolve and writes nothing", () => {
    const db = tempDb([gateMigration(1), gateResolverMigration(2), gateRuleMigration(3)]);
    const store = new SqliteGateStore(db, { migrate: false, evidencePolicy: goneOnly });
    store.create({ id: "run-1/approve-merge", prompt: "merge?" });

    expect(() => store.resolve("run-1/approve-merge", {}, COORDINATOR, EVIDENCE)).toThrow(GateStoreSchemaOutdated);
    expect(store.get("run-1/approve-merge")?.status).toBe("pending");
    expect(store.resolve("run-1/approve-merge", {}, OWNER).status).toBe("resolved");
  });
});
