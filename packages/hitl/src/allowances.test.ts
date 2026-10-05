import { ACTOR_CLASSES, RESOLVER_CLASSES, type ActorClass } from "@titan-design/authority";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryGateStore } from "./memory-store.js";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "./sqlite-store.js";
import { GateResolverRefused, type GateAnswerAllowance, type GateResolver, type GateStore } from "./types.js";

const RETRY: GateAnswerAllowance = { resolverClass: "coordinator", stepId: "stuck-behind", payload: { decision: "retry" } };
const coordinator = (id = "tc-fixture"): GateResolver => ({ class: "coordinator", id, channel: "test-cli" });
const OWNER: GateResolver = { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" };
const NON_OWNER_CLASSES = ACTOR_CLASSES.filter((c) => c !== "coordinator" && !(RESOLVER_CLASSES as readonly ActorClass[]).includes(c));

const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

function memory(allowances: GateAnswerAllowance[]): GateStore {
  return new MemoryGateStore({ allowances });
}

function sqlite(allowances: GateAnswerAllowance[]): GateStore {
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-allow-"));
  const db = openDatabase(path.join(dir, "gates.sqlite3"));
  runMigrations(db, [gateMigration(1), gateResolverMigration(2)]);
  disposers.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new SqliteGateStore(db, { migrate: false, allowances });
}

describe.each([
  ["MemoryGateStore", memory],
  ["SqliteGateStore", sqlite],
])("%s answer allowances", (_name, make) => {
  const resolveAs = (resolver: GateResolver, gateId: string, payload: unknown, allowances = [RETRY]) => {
    const store = make(allowances);
    store.create({ id: gateId, prompt: "go?" });
    return { store, run: () => store.resolve(gateId, payload, resolver) };
  };
  const refusedBy = (run: () => unknown) => expect(run).toThrow(GateResolverRefused);

  it("a coordinator retries stuck-behind and the resolution records its class and name", () => {
    const { run } = resolveAs(coordinator("tc-fixture"), "run-1/stuck-behind", { decision: "retry" });

    expect(run()).toMatchObject({ status: "resolved", resolvedBy: { class: "coordinator", id: "tc-fixture", channel: "test-cli" } });
  });

  it("a coordinator retries a repeat stuck-behind:1 gate", () => {
    const { run } = resolveAs(coordinator(), "run-1/stuck-behind:1", { decision: "retry" });

    expect(run().status).toBe("resolved");
  });

  it("a coordinator abandoning stuck-behind is refused with the default message and the gate stays pending", () => {
    const { store, run } = resolveAs(coordinator(), "run-1/stuck-behind", { decision: "abandon" });

    expect(run).toThrow("actor class coordinator may not resolve a gate");
    expect(store.get("run-1/stuck-behind")?.status).toBe("pending");
  });

  it("a coordinator answering stuck-behind with an extra payload key is refused", () => {
    refusedBy(resolveAs(coordinator(), "run-1/stuck-behind", { decision: "retry", extra: 1 }).run);
  });

  it.each(["approve-merge", "ci-failed", "main-red", "stuck-behind-not", "xstuck-behind"])("a coordinator retrying %s is refused", (step) => {
    refusedBy(resolveAs(coordinator(), `run-1/${step}`, { decision: "retry" }).run);
  });

  it.each(NON_OWNER_CLASSES)("%s retrying stuck-behind is refused", (actorClass) => {
    refusedBy(resolveAs({ class: actorClass, id: "x-fixture", channel: "test-cli" }, "run-1/stuck-behind", { decision: "retry" }).run);
  });

  it("a coordinator with a blank name is refused", () => {
    refusedBy(resolveAs(coordinator("  "), "run-1/stuck-behind", { decision: "retry" }).run);
  });

  it("a coordinator is refused everywhere when the store declares no allowance", () => {
    refusedBy(resolveAs(coordinator(), "run-1/stuck-behind", { decision: "retry" }, []).run);
  });

  it("an allowance list changed after the store is built does not widen it", () => {
    const allowances: GateAnswerAllowance[] = [];
    const { run } = resolveAs(coordinator(), "run-1/stuck-behind", { decision: "retry" }, allowances);
    allowances.push(RETRY);

    refusedBy(run);
  });

  it.each(["stuck-behind", "approve-merge", "ci-failed"])("owner-terminal resolves %s with any payload as before", (step) => {
    const { run } = resolveAs(OWNER, `run-1/${step}`, { decision: "abandon" });

    expect(run().resolvedBy).toMatchObject({ class: "owner-terminal" });
  });
});
