import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { silentLogger } from "./logger.js";
import { createTestContext, createTestRegistry } from "./test-fixtures.js";

// Pins the exact bytes a client sees, so moving the wire contract into another package cannot drift it.

let stateDir: string;
let handle: DaemonHandle;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "titan-wire-"));
  handle = await startDaemon({
    registry: createTestRegistry(),
    createContext: createTestContext,
    version: "1.2.3",
    stateDir,
    port: 0,
    logger: silentLogger,
  });
});

afterEach(async () => {
  await handle.close();
  await rm(stateDir, { recursive: true, force: true });
});

async function rpc(name: string, body: string): Promise<{ status: number; type: string | null; text: string }> {
  const res = await fetch(`http://127.0.0.1:${handle.port}/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-titan-client": "test" },
    body,
  });
  return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  return seen;
}

describe("wire compatibility over a real socket", () => {
  it("emits a success envelope byte for byte", async () => {
    const res = await rpc("greet", JSON.stringify({ name: "wire" }));

    expect(res.status).toBe(200);
    expect(res.type).toBe("application/json");
    expect(res.text).toBe('{"ok":true,"data":{"greeting":"hello wire"},"warnings":["via http"]}');
  });

  it("emits error envelopes byte for byte with their statuses", async () => {
    const thrown = await rpc("boom", "{}");
    const unknown = await rpc("nope", "{}");
    const badJson = await rpc("greet", "{not json");
    const badArgs = await rpc("greet", JSON.stringify({ name: 42 }));

    expect([thrown.status, thrown.text]).toEqual([500, '{"ok":false,"error":"kaboom","code":78}']);
    expect([unknown.status, unknown.text]).toEqual([404, '{"ok":false,"error":"Unknown command: nope","code":64}']);
    expect([badJson.status, badJson.text]).toEqual([400, '{"ok":false,"error":"Invalid JSON body","code":64}']);
    expect([badArgs.status, badArgs.text]).toEqual([
      400,
      '{"ok":false,"error":"Invalid arguments: name: Invalid input: expected string, received number","code":65}',
    ]);
  });

  it("emits the ready frame on connect and forwards broadcasts as SSE frames", async () => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${handle.port}/events`, { signal: controller.signal });
    const reader = res.body!.getReader();

    const ready = await readUntil(reader, "\n\n");
    handle.hub.broadcast({ event: "change", data: '{"path":"a.ts"}' });
    const change = await readUntil(reader, "\n\n");
    controller.abort();

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(ready).toBe("event: ready\ndata: connected\n\n");
    expect(change).toBe('event: change\ndata: {"path":"a.ts"}\n\n');
  });
});
