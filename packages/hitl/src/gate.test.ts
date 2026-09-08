import { openDatabase } from "@titan-design/store-sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { cancelGate, openGate, resolveGate, waitForGate } from "./gate.js";
import { MemoryGateStore } from "./memory-store.js";
import { SqliteGateStore } from "./sqlite-store.js";
import { GateAborted, GateCancelled, GateExpired, GateNotFound, GatePayloadInvalid } from "./types.js";

const approval = z.object({ approved: z.boolean(), note: z.string().optional() });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-gate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "gates.sqlite3");
}

function sqliteStore(dbPath: string): SqliteGateStore {
  const db = openDatabase(dbPath);
  cleanups.push(() => db.close());
  return new SqliteGateStore(db);
}

describe("openGate", () => {
  it("stores the zod schema as JSON Schema so another process can validate", () => {
    const store = new MemoryGateStore();
    const gate = openGate(store, { id: "g1", prompt: "ship it?", schema: approval });
    expect(store.get(gate.id)?.schema).toMatchObject({ type: "object", required: ["approved"] });
  });

  it("resolves with the validated payload once someone answers", async () => {
    const store = new MemoryGateStore();
    const gate = openGate(store, { prompt: "ship it?", schema: approval });
    setTimeout(() => resolveGate(store, gate.id, { approved: true, note: "green" }), 5);
    await expect(gate.wait({ pollMs: 1 })).resolves.toEqual({ approved: true, note: "green" });
  });

  it("resolves with the raw payload when no schema was given", async () => {
    const store = new MemoryGateStore();
    const gate = openGate<string>(store, { prompt: "which branch?" });
    resolveGate(store, gate.id, "main");
    await expect(gate.wait({ pollMs: 1 })).resolves.toBe("main");
  });

  it("rejects when the gate is cancelled", async () => {
    const store = new MemoryGateStore();
    const gate = openGate(store, { prompt: "ship it?" });
    setTimeout(() => cancelGate(store, gate.id, "the release was pulled"), 5);
    await expect(gate.wait({ pollMs: 1 })).rejects.toThrow(GateCancelled);
  });

  it("carries the cancellation reason on the error", async () => {
    const store = new MemoryGateStore();
    const gate = openGate(store, { prompt: "ship it?" });
    cancelGate(store, gate.id, "the release was pulled");
    await expect(gate.wait({ pollMs: 1 })).rejects.toThrow(/the release was pulled/);
  });

  it("rejects once the gate expires", async () => {
    let millis = Date.UTC(2026, 8, 8, 10, 0, 0);
    const store = new MemoryGateStore({ now: () => millis });
    const gate = openGate(store, { prompt: "ship it?", expiresAt: new Date(millis + 1_000) });
    const pending = gate.wait({ pollMs: 1 });
    millis += 2_000;
    await expect(pending).rejects.toThrow(GateExpired);
  });

  it("stops waiting when the caller aborts", async () => {
    const store = new MemoryGateStore();
    const controller = new AbortController();
    const gate = openGate(store, { prompt: "ship it?" });
    const pending = gate.wait({ pollMs: 1, signal: controller.signal });
    controller.abort("the run was cancelled");
    await expect(pending).rejects.toThrow(GateAborted);
    expect(store.get(gate.id)?.status).toBe("pending");
  });

  it("refuses a payload the schema does not accept", () => {
    const store = new MemoryGateStore();
    const gate = openGate(store, { prompt: "ship it?", schema: approval });
    expect(() => resolveGate(store, gate.id, { approved: "yes" })).toThrow(GatePayloadInvalid);
  });
});

describe("waitForGate", () => {
  it("re-attaches to a gate opened by a process that has since exited", async () => {
    const dbPath = tempDbPath();

    const opener = sqliteStore(dbPath);
    const gate = openGate(opener, { id: "deploy-approval", prompt: "ship it?", schema: approval });
    expect(gate.record.status).toBe("pending");

    const resolver = sqliteStore(dbPath);
    expect(resolver.listPending().map((g) => g.id)).toEqual(["deploy-approval"]);
    resolveGate(resolver, "deploy-approval", { approved: true });

    const restarted = sqliteStore(dbPath);
    const payload = await waitForGate(restarted, "deploy-approval", { schema: approval, pollMs: 1 });
    expect(payload).toEqual({ approved: true });
  });

  it("unblocks a waiter when a second connection resolves the same row", async () => {
    const dbPath = tempDbPath();
    const waiter = sqliteStore(dbPath);
    const other = sqliteStore(dbPath);

    const gate = openGate(waiter, { id: "g1", prompt: "ship it?", schema: approval });
    const pending = gate.wait({ pollMs: 1 });
    setTimeout(() => resolveGate(other, "g1", { approved: false }), 5);
    await expect(pending).resolves.toEqual({ approved: false });
  });

  it("rejects when the gate does not exist", async () => {
    await expect(waitForGate(new MemoryGateStore(), "nope", { pollMs: 1 })).rejects.toThrow(GateNotFound);
  });

  it("rejects when the stored payload does not satisfy the waiter's schema", async () => {
    const store = new MemoryGateStore();
    const gate = openGate(store, { prompt: "ship it?" });
    resolveGate(store, gate.id, { approved: "maybe" });
    await expect(waitForGate(store, gate.id, { schema: approval, pollMs: 1 })).rejects.toThrow(GatePayloadInvalid);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const store = new MemoryGateStore();
    const gate = openGate(store, { prompt: "ship it?" });
    const options = { pollMs: 1, signal: AbortSignal.abort("gone") };
    await expect(waitForGate(store, gate.id, options)).rejects.toThrow(GateAborted);
  });
});
