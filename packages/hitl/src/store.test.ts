import { ACTOR_CLASSES, RESOLVER_CLASSES, type ActorClass } from "@titan-design/authority";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGateStore } from "./memory-store.js";
import { SqliteGateStore, gateBriefMigration, gateMigration, gateResolverMigration, gateRuleMigration } from "./sqlite-store.js";
import {
  GateAlreadyExists,
  GateAlreadySettled,
  GateAuthorizeInvalid,
  GateBriefInvalid,
  GateExpired,
  GateNotFound,
  GatePayloadInvalid,
  GateResolverRefused,
  GateRuleInvalid,
  type GateAuthorize,
  type GateQuestion,
  type GateResolver,
  type GateRule,
  type GateStore,
} from "./types.js";

const APPROVAL_SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" }, note: { type: "string" } },
  required: ["approved"],
  additionalProperties: false,
};

interface Harness {
  store: GateStore;
  setNow: (millis: number) => void;
  dispose: () => void;
}

const T0 = Date.UTC(2026, 8, 8, 10, 0, 0);
const OWNER: GateResolver = { class: "owner-terminal", id: "owner-fixture", channel: "test-cli" };
const REMOTE: GateResolver = { class: "owner-remote", id: "@owner:example.test", channel: "matrix" };
/** Stands in for a caller that bypasses the type, such as plain JavaScript. */
const ANONYMOUS = undefined as unknown as GateResolver;
const TERMINAL_ONLY: GateRule = { table: "F5", version: "1.0.0", ruleId: "REL-CO", resolvers: ["owner-terminal"] };
const BRIEF = { summary: "Ship 1.4.0? CI green. Recommend ship.", evidenceRef: "https://example.test/runs/1" };
const SHIP_QUESTIONS: GateQuestion[] = [
  { id: "decision", question: "Ship 1.4.0?", options: [{ id: "ship", label: "Ship", recommended: true }, { id: "hold", label: "Hold" }] },
];
const AGENT_CLASSES = ACTOR_CLASSES.filter((c) => !(RESOLVER_CLASSES as readonly ActorClass[]).includes(c));

function memoryHarness(authorize?: GateAuthorize, requireBrief = false): Harness {
  let millis = T0;
  const options = { now: () => millis, requireBrief };
  return {
    store: new MemoryGateStore(authorize ? { ...options, authorize } : options),
    setNow: (value) => {
      millis = value;
    },
    dispose: () => {},
  };
}

function sqliteHarness(authorize?: GateAuthorize, requireBrief = false): Harness {
  let millis = T0;
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-"));
  const db = openDatabase(path.join(dir, "gates.sqlite3"));
  runMigrations(db, [gateMigration(1), gateResolverMigration(2), gateRuleMigration(3), gateBriefMigration(4)]);
  const options = { migrate: false, now: () => millis, requireBrief };
  return {
    store: new SqliteGateStore(db, authorize ? { ...options, authorize } : options),
    setNow: (value) => {
      millis = value;
    },
    dispose: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe.each([
  ["MemoryGateStore", memoryHarness],
  ["SqliteGateStore", sqliteHarness],
])("%s", (_name, makeHarness) => {
  let harness: Harness;
  let store: GateStore;

  beforeEach(() => {
    harness = makeHarness();
    store = harness.store;
  });

  afterEach(() => harness.dispose());

  it("creates a pending gate and reads it back by id", () => {
    const created = store.create({ id: "g1", prompt: "ship it?" });
    expect(created).toMatchObject({ id: "g1", prompt: "ship it?", status: "pending" });
    expect(store.get("g1")).toMatchObject({ status: "pending", createdAt: new Date(T0).toISOString() });
  });

  it("mints an id when the caller does not supply one", () => {
    expect(store.create({ prompt: "who?" }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a duplicate id", () => {
    store.create({ id: "g1", prompt: "first" });
    expect(() => store.create({ id: "g1", prompt: "second" })).toThrow(GateAlreadyExists);
  });

  it("returns undefined for an unknown id", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  it("records the payload and the time it was resolved", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    harness.setNow(T0 + 5_000);
    const resolved = store.resolve("g1", { approved: true }, OWNER);
    expect(resolved).toMatchObject({
      status: "resolved",
      payload: { approved: true },
      resolvedAt: new Date(T0 + 5_000).toISOString(),
    });
  });

  it("round-trips a null payload as a value, not as absence", () => {
    store.create({ id: "g1", prompt: "anything?" });
    store.resolve("g1", null, OWNER);
    expect(store.get("g1")?.payload).toBeNull();
  });

  it("rejects a second resolve", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    store.resolve("g1", { approved: true }, OWNER);
    expect(() => store.resolve("g1", { approved: false }, OWNER)).toThrow(GateAlreadySettled);
    expect(store.get("g1")?.payload).toEqual({ approved: true });
  });

  it("rejects resolving an unknown gate", () => {
    expect(() => store.resolve("nope", {}, OWNER)).toThrow(GateNotFound);
  });

  it("cancels a pending gate with a reason", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    expect(store.cancel("g1", "superseded")).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(() => store.cancel("g1", "again")).toThrow(GateAlreadySettled);
  });

  it("rejects a payload that does not match the stored schema", () => {
    store.create({ id: "g1", prompt: "ship it?", schema: APPROVAL_SCHEMA });
    expect(() => store.resolve("g1", { note: "looks fine" }, OWNER)).toThrow(GatePayloadInvalid);
    expect(store.get("g1")?.status).toBe("pending");
  });

  it("accepts a payload that matches the stored schema", () => {
    store.create({ id: "g1", prompt: "ship it?", schema: APPROVAL_SCHEMA });
    expect(store.resolve("g1", { approved: false, note: "not yet" }, OWNER).status).toBe("resolved");
  });

  it("lists pending gates oldest first and drops settled ones", () => {
    store.create({ id: "a", prompt: "first" });
    harness.setNow(T0 + 1_000);
    store.create({ id: "b", prompt: "second" });
    harness.setNow(T0 + 2_000);
    store.create({ id: "c", prompt: "third" });
    store.resolve("b", "done", OWNER);
    expect(store.listPending().map((g) => g.id)).toEqual(["a", "c"]);
  });

  it("lapses a gate to expired once its deadline passes", () => {
    store.create({ id: "g1", prompt: "ship it?", expiresAt: new Date(T0 + 1_000) });
    expect(store.get("g1")?.status).toBe("pending");
    harness.setNow(T0 + 1_001);
    expect(store.get("g1")?.status).toBe("expired");
    expect(store.listPending()).toEqual([]);
  });

  it("treats the expiry instant itself as expired", () => {
    store.create({ id: "g1", prompt: "ship it?", expiresAt: new Date(T0 + 1_000) });
    harness.setNow(T0 + 999);
    expect(store.get("g1")?.status).toBe("pending");
    harness.setNow(T0 + 1_000);
    expect(store.get("g1")?.status).toBe("expired");
  });

  it("refuses to resolve an expired gate", () => {
    store.create({ id: "g1", prompt: "ship it?", expiresAt: new Date(T0 + 1_000) });
    harness.setNow(T0 + 5_000);
    expect(() => store.resolve("g1", "late", OWNER)).toThrow(GateExpired);
  });

  it("keeps an expiry that has not arrived out of the way", () => {
    store.create({ id: "g1", prompt: "ship it?", expiresAt: new Date(T0 + 60_000) });
    harness.setNow(T0 + 30_000);
    expect(store.resolve("g1", "in time", OWNER).status).toBe("resolved");
  });

  it("records who resolved the gate and reads it back", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    const remote: GateResolver = { class: "owner-remote", id: "@owner:example.test", channel: "matrix", confirmEvent: "$evt1" };
    store.resolve("g1", { approved: true }, remote);
    expect(store.get("g1")?.resolvedBy).toEqual(remote);
  });

  it("keeps the stored resolver when a caller mutates the record it was handed", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    store.resolve("g1", "ok", { ...OWNER });
    const read = store.get("g1");
    if (read?.resolvedBy) read.resolvedBy.id = "someone-else";
    expect(store.get("g1")?.resolvedBy).toEqual(OWNER);
  });

  it("leaves resolvedBy unset on a gate nobody has resolved", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    store.cancel("g1", "superseded");
    expect(store.get("g1")?.resolvedBy).toBeUndefined();
  });

  it("refuses a worker resolution and leaves the gate open and unchanged", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    const before = store.get("g1");
    const worker: GateResolver = { class: "worker", id: "agent-fixture", channel: "chat" };
    expect(() => store.resolve("g1", { approved: true }, worker)).toThrow(GateResolverRefused);
    expect(store.get("g1")).toEqual(before);
    expect(store.get("g1")).toMatchObject({ status: "pending", resolvedBy: undefined });
  });

  it.each(AGENT_CLASSES)("refuses a resolution by the %s class", (actorClass) => {
    store.create({ id: "g1", prompt: "ship it?" });
    expect(() => store.resolve("g1", "ok", { class: actorClass, id: "x", channel: "y" })).toThrow(GateResolverRefused);
    expect(store.get("g1")?.status).toBe("pending");
  });

  it("names the gate and the actor class in a refusal, never the resolver's own fields", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    const worker: GateResolver = { class: "worker", id: "secret-agent-id", channel: "secret-channel", confirmEvent: "secret-evt" };
    const error = catchError(() => store.resolve("g1", "ok", worker));
    expect(error).toBeInstanceOf(GateResolverRefused);
    expect(error).toMatchObject({ gateId: "g1", actorClass: "worker" });
    expect((error as Error).message).toContain("g1");
    expect((error as Error).message).toContain("worker");
    expect((error as Error).message).not.toMatch(/secret/);
  });

  it("still refuses an agent class that authorize allows", () => {
    const allowAll = scoped(makeHarness(() => ({ allowed: true }))).store;
    allowAll.create({ id: "g1", prompt: "ship it?" });
    const coordinator: GateResolver = { class: "coordinator", id: "agent-fixture", channel: "chat" };
    expect(() => allowAll.resolve("g1", "ok", coordinator)).toThrow(GateResolverRefused);
    expect(allowAll.get("g1")?.status).toBe("pending");
  });

  it("lets authorize refuse an owner resolver and carries its reason", () => {
    const refuseRemote: GateAuthorize = (_gate, resolver) =>
      resolver?.class === "owner-remote" ? { allowed: false, reason: "remote resolution is off" } : { allowed: true };
    const narrowed = scoped(makeHarness(refuseRemote)).store;
    narrowed.create({ id: "g1", prompt: "ship it?" });
    const error = catchError(() => narrowed.resolve("g1", "ok", { class: "owner-remote", id: "o", channel: "matrix" }));
    expect(error).toBeInstanceOf(GateResolverRefused);
    expect(error).toMatchObject({ reason: "remote resolution is off" });
    expect(narrowed.get("g1")).toMatchObject({ status: "pending", resolvedBy: undefined });
    expect(narrowed.resolve("g1", "ok", OWNER).resolvedBy).toEqual(OWNER);
  });

  it("hands authorize the pending gate and the resolver", () => {
    const seen: unknown[] = [];
    const recording = scoped(
      makeHarness((gate, resolver) => {
        seen.push([gate.id, gate.status, resolver]);
        return { allowed: true };
      }),
    ).store;
    recording.create({ id: "g1", prompt: "ship it?" });
    recording.resolve("g1", "ok", OWNER);
    expect(seen).toEqual([["g1", "pending", OWNER]]);
  });

  it("checks and stores one reading of the resolver", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    store.create({ id: "g2", prompt: "ship it?" });
    expect(store.resolve("g1", "ok", shiftingClass("owner-terminal", "worker")).resolvedBy?.class).toBe("owner-terminal");
    expect(store.get("g1")?.resolvedBy?.class).toBe("owner-terminal");
    expect(() => store.resolve("g2", "ok", shiftingClass("worker", "owner-terminal"))).toThrow(GateResolverRefused);
    expect(store.get("g2")).toMatchObject({ status: "pending", resolvedBy: undefined });
  });

  it("stores only declared resolver fields", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    store.create({ id: "g2", prompt: "ship it?" });
    const withExtra = { ...OWNER, confirmEvent: "$evt1", token: "undeclared" } as GateResolver;
    const noEventWithExtra = { ...OWNER, token: "undeclared" } as GateResolver;
    store.resolve("g1", "ok", withExtra);
    store.resolve("g2", "ok", noEventWithExtra);
    expect(store.get("g1")?.resolvedBy).toEqual({ ...OWNER, confirmEvent: "$evt1" });
    expect(store.get("g2")?.resolvedBy).toEqual(OWNER);
  });

  it("refuses a resolver whose class is not a string", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    const numeric = { ...OWNER, class: 42 } as unknown as GateResolver;
    const noChannel = { class: "owner-terminal", id: "o" } as unknown as GateResolver;
    expect(catchError(() => store.resolve("g1", "ok", numeric))).toMatchObject({
      name: "GateResolverRefused",
      actorClass: undefined,
    });
    expect(() => store.resolve("g1", "ok", noChannel)).toThrow(GateResolverRefused);
    expect(store.get("g1")).toMatchObject({ status: "pending", resolvedBy: undefined });
  });

  it("never echoes a class outside the actor vocabulary", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    const invented = { ...OWNER, class: "superuser-invented" } as unknown as GateResolver;
    const error = catchError(() => store.resolve("g1", "ok", invented));
    expect(error).toMatchObject({ name: "GateResolverRefused", actorClass: undefined });
    expect((error as Error).message).not.toContain("superuser-invented");
  });

  it("refuses a resolve that names no resolver and leaves the gate pending", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    expect(() => store.resolve("g1", "ok", ANONYMOUS)).toThrow(
      expect.objectContaining({ name: "GateResolverRefused", gateId: "g1", actorClass: undefined, reason: "a resolver is required" }),
    );
    expect(store.get("g1")).toMatchObject({ status: "pending", payload: undefined, resolvedBy: undefined });
  });

  it("refuses an anonymous resolution before authorize runs", () => {
    let calls = 0;
    const permissive = (_gate: unknown, resolver: GateResolver | undefined) => {
      calls += 1;
      return resolver?.class === "owner-remote" ? { allowed: false as const, reason: "no remote" } : { allowed: true as const };
    };
    const guarded = scoped(makeHarness(permissive)).store;
    guarded.create({ id: "g1", prompt: "ship it?" });
    expect(() => guarded.resolve("g1", "ok", ANONYMOUS)).toThrow(GateResolverRefused);
    expect(guarded.get("g1")).toMatchObject({ status: "pending", resolvedBy: undefined });
    expect(calls).toBe(0);
  });

  it.each([
    ["a promise", () => Promise.reject(new Error("async policy"))],
    ["undefined", () => undefined],
  ])("refuses an authorize that returns %s and leaves the gate open", (_label, callback) => {
    const odd = scoped(makeHarness(callback as unknown as GateAuthorize)).store;
    odd.create({ id: "g1", prompt: "ship it?" });
    const before = odd.get("g1");
    expect(() => odd.resolve("g1", "ok", OWNER)).toThrow(GateAuthorizeInvalid);
    expect(odd.get("g1")).toEqual(before);
  });

  it("lets an authorize that throws propagate and leaves the gate unchanged", () => {
    const failing = scoped(
      makeHarness(() => {
        throw new Error("policy backend down");
      }),
    ).store;
    failing.create({ id: "g1", prompt: "ship it?" });
    const before = failing.get("g1");
    expect(() => failing.resolve("g1", "ok", OWNER)).toThrow("policy backend down");
    expect(failing.get("g1")).toEqual(before);
  });

  it("refuses a resolver whose class the gate's rule does not name and leaves the gate pending", () => {
    store.create({ id: "g1", prompt: "release?", rule: TERMINAL_ONLY });
    const error = catchError(() => store.resolve("g1", { approved: true }, REMOTE));
    expect(error).toBeInstanceOf(GateResolverRefused);
    expect(error).toMatchObject({ gateId: "g1", actorClass: "owner-remote" });
    expect(store.get("g1")).toMatchObject({ status: "pending", payload: undefined, resolvedBy: undefined });
  });

  it("resolves for a class the rule names and reads the rule back unchanged", () => {
    store.create({ id: "g1", prompt: "release?", rule: TERMINAL_ONLY });
    expect(store.resolve("g1", "ok", OWNER)).toMatchObject({ status: "resolved", resolvedBy: OWNER, rule: TERMINAL_ONLY });
    expect(store.get("g1")?.rule).toEqual(TERMINAL_ONLY);
  });

  it("lets a gate without a rule resolve for owner-remote as before", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    expect(store.resolve("g1", "ok", REMOTE).resolvedBy).toEqual(REMOTE);
    expect(store.get("g1")?.rule).toBeUndefined();
  });

  it("refuses an anonymous resolve of a rule-bound gate", () => {
    store.create({ id: "g1", prompt: "release?", rule: TERMINAL_ONLY });
    expect(() => store.resolve("g1", "ok", ANONYMOUS)).toThrow(GateResolverRefused);
    expect(store.get("g1")?.status).toBe("pending");
  });

  it("keeps the stored rule when a caller mutates the rule it passed in or read back", () => {
    const input: GateRule = { ...TERMINAL_ONLY, resolvers: ["owner-terminal"] };
    store.create({ id: "g1", prompt: "release?", rule: input });
    input.resolvers.push("owner-remote");
    store.get("g1")?.rule?.resolvers.push("owner-remote");
    expect(store.get("g1")?.rule).toEqual(TERMINAL_ONLY);
    expect(() => store.resolve("g1", "ok", REMOTE)).toThrow(GateResolverRefused);
  });

  it.each([
    ["no resolvers", { ...TERMINAL_ONLY, resolvers: [] }],
    ["an agent class", { ...TERMINAL_ONLY, resolvers: ["coordinator"] }],
    ["a missing ruleId", { table: "F5", version: "1.0.0", resolvers: ["owner-terminal"] }],
  ])("refuses a rule with %s and creates nothing", (_label, rule) => {
    expect(() => store.create({ id: "g1", prompt: "release?", rule: rule as GateRule })).toThrow(GateRuleInvalid);
    expect(store.get("g1")).toBeUndefined();
  });

  it("a refused brief writes no row", () => {
    const strict = scoped(makeHarness(undefined, true)).store;

    expect(() => strict.create({ id: "g1", prompt: "ship it?", evidenceRef: BRIEF.evidenceRef })).toThrow(GateBriefInvalid);

    expect(strict.get("g1")).toBeUndefined();
  });

  it("a store without requireBrief opens a bare gate as before", () => {
    const created = store.create({ id: "g1", prompt: "ship it?" });

    expect(created).toMatchObject({ status: "pending", summary: undefined, evidenceRef: undefined, questions: undefined });
    expect(store.get("g1")?.summary).toBeUndefined();
  });

  it("a store with requireBrief opens a gate that carries one", () => {
    const strict = scoped(makeHarness(undefined, true)).store;

    strict.create({ id: "g1", prompt: "ship it?", ...BRIEF, questions: SHIP_QUESTIONS });

    expect(strict.get("g1")).toMatchObject({ ...BRIEF, questions: SHIP_QUESTIONS });
  });

  it("a store without requireBrief still refuses a malformed brief", () => {
    expect(() => store.create({ id: "g1", prompt: "ship it?", summary: "  " })).toThrow(GateBriefInvalid);

    expect(store.get("g1")).toBeUndefined();
  });

  it("mutating the questions array after create does not change the stored gate", () => {
    const input = structuredClone(SHIP_QUESTIONS);
    const created = store.create({ id: "g1", prompt: "ship it?", questions: input });
    const read = store.get("g1");

    input.push(input[0] as GateQuestion);
    for (const mutated of [created.questions, read?.questions]) {
      (mutated?.[0]?.options[0] as { label: string }).label = "changed";
      mutated?.pop();
    }

    expect(store.get("g1")?.questions).toEqual(SHIP_QUESTIONS);
  });

  function scoped(extra: Harness): Harness {
    extraHarnesses.push(extra);
    return extra;
  }
});

const extraHarnesses: Harness[] = [];
afterEach(() => {
  while (extraHarnesses.length > 0) extraHarnesses.pop()?.dispose();
});

/** A resolver whose class reads differently the second time, to prove the store reads it once. */
function shiftingClass(first: ActorClass, later: ActorClass): GateResolver {
  let reads = 0;
  return {
    get class() {
      reads += 1;
      return reads === 1 ? first : later;
    },
    id: "shifty",
    channel: "test-cli",
  };
}

function catchError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to throw");
}
