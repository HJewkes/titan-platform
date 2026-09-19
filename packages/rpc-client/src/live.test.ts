import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "@titan-design/rpc-protocol";
import { RpcError, createRpcClient, liveSource, type LiveStatus, type RpcClient } from "./index.js";
import { createTestRegistry, startTestDaemon, type Commands, type TestDaemon } from "./test-fixtures.js";

let daemon: TestDaemon;
let client: RpcClient<Commands>;

beforeEach(async () => {
  daemon = await startTestDaemon(createTestRegistry());
  client = createRpcClient<Commands>(liveSource({ origin: daemon.origin, reconnectDelayMs: 10, maxReconnectDelayMs: 50 }));
});

afterEach(async () => {
  await daemon.close();
});

/** Resolves once `predicate` holds, polling briefly; the stream is asynchronous by nature. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("liveSource against a real daemon", () => {
  it("returns a typed result through the daemon's Host, Origin, and Content-Type guards", async () => {
    expect(await client.call("task.list", { status: "open" })).toEqual({ slugs: ["a", "c"] });
    expect(await client.call("task.list")).toEqual({ slugs: ["a", "b", "c"] });
  });

  it("maps a thrown command error and invalid args to RpcError with their exit codes", async () => {
    const missing = await client.call("task.get", { slug: "zzz" }).catch((err: unknown) => err);
    const invalid = await client.call("task.get", { slug: 7 as unknown as string }).catch((err: unknown) => err);
    expect(missing).toBeInstanceOf(RpcError);
    expect(missing).toMatchObject({ command: "task.get", code: EXIT.NOINPUT, message: "No task zzz" });
    expect(invalid).toMatchObject({ code: EXIT.DATAERR });
  });

  it("answers UNAVAILABLE, not a throw, when no daemon is listening", async () => {
    const port = daemon.handle.port;
    await daemon.handle.close();
    const envelope = await liveSource({ origin: `http://127.0.0.1:${port}` }).call("task.list", {});
    expect(envelope).toMatchObject({ ok: false, code: EXIT.UNAVAILABLE });
  });

  it("aborts an in-flight call with the signal's reason", async () => {
    const controller = new AbortController();
    const pending = client.call("task.slow", { ms: 1000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("delivers a broadcast frame and hides the ready and ping frames", async () => {
    const events: string[] = [];
    const statuses: LiveStatus[] = [];
    const sub = client.subscribe({ onEvent: (m) => events.push(`${m.event}:${m.data}`), onStatus: (s) => statuses.push(s) });
    await waitFor(() => statuses.includes("open"));
    daemon.handle.hub.broadcast({ event: "change", data: "/repo" });
    await waitFor(() => events.length === 1);
    sub.close();
    await waitFor(() => statuses.at(-1) === "closed");
    expect(events).toEqual(["change:/repo"]);
    expect(statuses).toEqual(["connecting", "open", "closed"]);
  });

  it("reconnects after the daemon restarts and receives the new daemon's broadcasts", async () => {
    const events: string[] = [];
    const statuses: LiveStatus[] = [];
    const sub = client.subscribe({ onEvent: (m) => events.push(m.data), onStatus: (s) => statuses.push(s) });
    await waitFor(() => statuses.includes("open"));
    await daemon.restart();
    await waitFor(() => statuses.filter((s) => s === "open").length === 2);
    daemon.handle.hub.broadcast({ event: "change", data: "after restart" });
    await waitFor(() => events.length === 1);
    sub.close();
    expect(events).toEqual(["after restart"]);
    expect(statuses.slice(0, 3)).toEqual(["connecting", "open", "connecting"]);
  });

  it("closes the stream when its signal aborts, and the daemon drops the subscriber", async () => {
    const controller = new AbortController();
    const statuses: LiveStatus[] = [];
    client.subscribe({ onEvent: () => undefined, onStatus: (s) => statuses.push(s) }, { signal: controller.signal });
    await waitFor(() => statuses.includes("open") && daemon.handle.hub.size === 1);
    controller.abort();
    await waitFor(() => statuses.at(-1) === "closed" && daemon.handle.hub.size === 0);
    expect(statuses).toEqual(["connecting", "open", "closed"]);
  });
});
