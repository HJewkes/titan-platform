import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXIT } from "@titan-design/rpc-protocol";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { silentLogger } from "./logger.js";
import { createTestContext, createTestRegistry } from "./test-fixtures.js";

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    async handleRequest(): Promise<void> {
      throw new Error("transport exploded");
    }
    async close(): Promise<void> {}
    async start(): Promise<void> {}
  },
}));

let stateDir: string;
let handle: DaemonHandle | null = null;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "titan-daemon-"));
});

afterEach(async () => {
  await handle?.close();
  handle = null;
  await rm(stateDir, { recursive: true, force: true });
});

function postMcp(port: number): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-titan-client": "test" };
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body }));
    });
    req.on("error", reject);
    req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  });
}

describe("a /mcp handler that throws", () => {
  it("answers 500 with a JSON error envelope", async () => {
    handle = await startDaemon({
      registry: createTestRegistry(),
      createContext: createTestContext,
      version: "1.2.3",
      stateDir,
      port: 0,
      logger: silentLogger,
      toolPrefix: "test__",
    });

    const res = await postMcp(handle.port);

    expect(res.status).toBe(500);
    expect(res.type).toContain("application/json");
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "Error: transport exploded", code: EXIT.SOFTWARE });
  });
});
