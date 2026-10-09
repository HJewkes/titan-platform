import { DELEGATE_RESOLVER_CLASSES } from "@titan-design/authority";
import { openDatabase } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryGateStore } from "./memory-store.js";
import { snapshotRule } from "./resolver-policy.js";
import { SqliteGateStore } from "./sqlite-store.js";
import { GateResolverRefused, GateRuleInvalid, type GateAuthorize, type GateResolver, type GateRule, type GateStore } from "./types.js";

const DELEGATING: GateRule = { table: "F5", version: "1.0.0", ruleId: "MRG-AU", resolvers: ["owner-terminal"], delegates: ["coordinator"] };
const OWNER_ONLY: GateRule = { table: "F5", version: "1.0.0", ruleId: "MRG-AU", resolvers: ["owner-terminal"] };
const OWNER: GateResolver = { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" };
const coordinator = (id = "tc-fixture"): GateResolver => ({ class: "coordinator", id, channel: "test-cli" });
const ALLOW: GateAuthorize = () => ({ allowed: true });
const REFUSE: GateAuthorize = () => ({ allowed: false, reason: "authorize refused the delegate" });
const DEFAULT_REFUSAL = "actor class coordinator may not resolve a gate";
const MERGE = { decision: "merge", headSha: "a".repeat(40) };

const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));

function memory(authorize?: GateAuthorize): GateStore {
  return new MemoryGateStore({ authorize });
}

function sqlite(authorize?: GateAuthorize): GateStore {
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-delegate-"));
  const db = openDatabase(path.join(dir, "gates.sqlite3"));
  disposers.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new SqliteGateStore(db, { authorize });
}

describe("delegate resolver classes", () => {
  it("DELEGATE_RESOLVER_CLASSES is exactly coordinator", () => {
    expect(DELEGATE_RESOLVER_CLASSES).toEqual(["coordinator"]);
  });

  it.each(["worker", "headless", "automation", "owner-terminal", "owner-remote", "janitor"])("a rule naming %s as a delegate is refused by snapshotRule", (actorClass) => {
    expect(() => snapshotRule("g1", { ...OWNER_ONLY, delegates: [actorClass] })).toThrow(GateRuleInvalid);
  });

  it.each([[[]], ["coordinator"], [["coordinator", "worker"]]])("a rule whose delegates are %j is refused by snapshotRule", (delegates) => {
    expect(() => snapshotRule("g1", { ...OWNER_ONLY, delegates })).toThrow(GateRuleInvalid);
  });

  it("a rule naming coordinator as a delegate is kept frozen by snapshotRule", () => {
    const rule = snapshotRule("g1", DELEGATING);

    expect(rule).toEqual(DELEGATING);
    expect(Object.isFrozen(rule.delegates)).toBe(true);
  });
});

describe.each([
  ["MemoryGateStore", memory],
  ["SqliteGateStore", sqlite],
])("%s delegate admission", (_name, make) => {
  const resolveAs = (resolver: GateResolver, rule: GateRule | undefined, authorize?: GateAuthorize) => {
    const store = make(authorize);
    store.create({ id: "run-1/approve-merge", prompt: "merge?", rule });
    return { store, run: () => store.resolve("run-1/approve-merge", MERGE, resolver) };
  };

  it("a coordinator the rule names in delegates is admitted when authorize allows it", () => {
    const { run } = resolveAs(coordinator(), DELEGATING, ALLOW);

    expect(run()).toMatchObject({ status: "resolved", payload: MERGE, resolvedBy: coordinator(), rule: DELEGATING });
  });

  it("a delegate is admitted only through authorize, which sees the gate's rule and the delegate", () => {
    const seen: Array<[string | undefined, string]> = [];
    const record: GateAuthorize = (gate, resolver) => {
      seen.push([gate.rule?.ruleId, resolver.class]);
      return { allowed: true };
    };
    const { run } = resolveAs(coordinator(), DELEGATING, record);

    run();

    expect(seen).toEqual([["MRG-AU", "coordinator"]]);
  });

  it("a coordinator the rule names in delegates is refused when authorize refuses it", () => {
    const { store, run } = resolveAs(coordinator(), DELEGATING, REFUSE);

    expect(run).toThrow("authorize refused the delegate");
    expect(store.get("run-1/approve-merge")?.status).toBe("pending");
  });

  it("a coordinator the rule names in delegates is refused exactly as on main when the store has no authorize", () => {
    const { store, run } = resolveAs(coordinator(), DELEGATING);

    expect(run).toThrow(DEFAULT_REFUSAL);
    expect(store.get("run-1/approve-merge")?.status).toBe("pending");
  });

  it("a coordinator is refused exactly as on main when the rule names no delegates", () => {
    expect(resolveAs(coordinator(), OWNER_ONLY, ALLOW).run).toThrow(DEFAULT_REFUSAL);
  });

  it("a coordinator is refused exactly as on main when the gate has no rule", () => {
    expect(resolveAs(coordinator(), undefined, ALLOW).run).toThrow(DEFAULT_REFUSAL);
  });

  it.each(["worker", "headless", "automation"] as const)("%s is refused on a delegating rule even when authorize allows it", (actorClass) => {
    expect(resolveAs({ class: actorClass, id: "x-fixture", channel: "test-cli" }, DELEGATING, ALLOW).run).toThrow(GateResolverRefused);
  });

  it("a coordinator with a blank name is refused on a delegating rule", () => {
    expect(resolveAs(coordinator("  "), DELEGATING, ALLOW).run).toThrow("must name itself");
  });

  it("a delegates list changed after create does not widen the gate", () => {
    const delegates: string[] = ["coordinator"];
    const rule = { ...OWNER_ONLY, delegates } as GateRule;
    const { run } = resolveAs({ class: "worker", id: "w-fixture", channel: "test-cli" }, rule, ALLOW);
    delegates.push("worker");

    expect(run).toThrow(GateResolverRefused);
  });

  it("the owner still resolves a delegating gate with or without authorize", () => {
    expect(resolveAs(OWNER, DELEGATING).run()).toMatchObject({ status: "resolved", resolvedBy: OWNER });
  });
});
