import { openDatabase } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGateStore } from "./memory-store.js";
import { SqliteGateStore } from "./sqlite-store.js";
import {
  GateAlreadyExists,
  GateAlreadySettled,
  GateExpired,
  GateNotFound,
  GatePayloadInvalid,
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

function memoryHarness(): Harness {
  let millis = T0;
  return {
    store: new MemoryGateStore({ now: () => millis }),
    setNow: (value) => {
      millis = value;
    },
    dispose: () => {},
  };
}

function sqliteHarness(): Harness {
  let millis = T0;
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-"));
  const db = openDatabase(path.join(dir, "gates.sqlite3"));
  return {
    store: new SqliteGateStore(db, { now: () => millis }),
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
    const resolved = store.resolve("g1", { approved: true });
    expect(resolved).toMatchObject({
      status: "resolved",
      payload: { approved: true },
      resolvedAt: new Date(T0 + 5_000).toISOString(),
    });
  });

  it("round-trips a null payload as a value, not as absence", () => {
    store.create({ id: "g1", prompt: "anything?" });
    store.resolve("g1", null);
    expect(store.get("g1")?.payload).toBeNull();
  });

  it("rejects a second resolve", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    store.resolve("g1", { approved: true });
    expect(() => store.resolve("g1", { approved: false })).toThrow(GateAlreadySettled);
    expect(store.get("g1")?.payload).toEqual({ approved: true });
  });

  it("rejects resolving an unknown gate", () => {
    expect(() => store.resolve("nope", {})).toThrow(GateNotFound);
  });

  it("cancels a pending gate with a reason", () => {
    store.create({ id: "g1", prompt: "ship it?" });
    expect(store.cancel("g1", "superseded")).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(() => store.cancel("g1", "again")).toThrow(GateAlreadySettled);
  });

  it("rejects a payload that does not match the stored schema", () => {
    store.create({ id: "g1", prompt: "ship it?", schema: APPROVAL_SCHEMA });
    expect(() => store.resolve("g1", { note: "looks fine" })).toThrow(GatePayloadInvalid);
    expect(store.get("g1")?.status).toBe("pending");
  });

  it("accepts a payload that matches the stored schema", () => {
    store.create({ id: "g1", prompt: "ship it?", schema: APPROVAL_SCHEMA });
    expect(store.resolve("g1", { approved: false, note: "not yet" }).status).toBe("resolved");
  });

  it("lists pending gates oldest first and drops settled ones", () => {
    store.create({ id: "a", prompt: "first" });
    harness.setNow(T0 + 1_000);
    store.create({ id: "b", prompt: "second" });
    harness.setNow(T0 + 2_000);
    store.create({ id: "c", prompt: "third" });
    store.resolve("b", "done");
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
    expect(() => store.resolve("g1", "late")).toThrow(GateExpired);
  });

  it("keeps an expiry that has not arrived out of the way", () => {
    store.create({ id: "g1", prompt: "ship it?", expiresAt: new Date(T0 + 60_000) });
    harness.setNow(T0 + 30_000);
    expect(store.resolve("g1", "in time").status).toBe("resolved");
  });
});
