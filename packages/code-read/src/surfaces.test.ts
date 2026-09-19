import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { silentLogger, startDaemon, type DaemonHandle, type Surface } from "@titan-design/daemon";
import { createRegistry, invokeCommand, type BaseContext } from "@titan-design/registry";
import type { JsonEnvelope } from "@titan-design/rpc-protocol";
import { COMMAND_NAMES, type CommandName } from "./query/contract.js";
import { registerCodeReadCommands } from "./register.js";
import { makeFixtureRepo, type FixtureRepo } from "./test-fixtures.js";

interface SurfaceContext extends BaseContext {
  surface: Surface | "in-process";
}

const CALLS: [CommandName, Record<string, unknown>][] = [
  ["api.describe", {}],
  ["snapshot.list", { ref: "main", limit: 5 }],
  ["hierarchy.get", { depth: 3, metrics: ["loc", "cognitive_max", "churn_30d_commits"], baseline: "main" }],
  ["node.get", { id: "src/util/" }],
  ["node.get", { id: "src/math.ts#add", baseline: 1 }],
  ["node.resolve", { query: "src/util/strings.ts:3" }],
  ["node.resolve", { query: "sh", limit: 5 }],
];

let repo: FixtureRepo;
let stateDir: string;
let daemon: DaemonHandle;
const registry = createRegistry<SurfaceContext>();

beforeAll(async () => {
  repo = await makeFixtureRepo();
  repo.commit("init");
  await repo.index("main");
  registerCodeReadCommands(registry, { openStore: () => repo.store });
  stateDir = await mkdtemp(path.join(os.tmpdir(), "code-read-daemon-"));
  daemon = await startDaemon({
    registry,
    createContext: (surface) => ({ warnings: [], format: "json", surface }),
    version: "0.0.0-test",
    stateDir,
    port: 0,
    toolPrefix: "codewatch__",
    logger: silentLogger,
  });
}, 60_000);

afterAll(async () => {
  await daemon?.close();
  await rm(stateDir, { recursive: true, force: true });
  await repo.cleanup();
});

async function inProcess(name: CommandName, args: unknown): Promise<JsonEnvelope<unknown>> {
  const { envelope } = await invokeCommand(registry.get(name)!, args, { warnings: [], format: "json", surface: "in-process" });
  return envelope;
}

async function overRpc(name: CommandName, args: unknown): Promise<JsonEnvelope<unknown>> {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return (await response.json()) as JsonEnvelope<unknown>;
}

describe("the same commands on every surface", () => {
  it.each(CALLS)("%s %j answers identically in process and over the daemon's /rpc", async (name, args) => {
    const local = await inProcess(name, args);

    expect(local.ok).toBe(true);
    expect(await overRpc(name, args)).toEqual(local);
  });

  it.each(CALLS)("%s %j answers identically as an MCP tool", async (name, args) => {
    const client = new Client({ name: "code-read-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`)));
    const tool = `codewatch__${name.replaceAll(".", "__")}`;

    const result = await client.callTool({ name: tool, arguments: args });
    await client.close();

    const [content] = result.content as { type: string; text: string }[];
    expect(JSON.parse(content!.text)).toEqual(await inProcess(name, args));
  });

  it("lists every command as an MCP tool until the registry can filter surfaces", async () => {
    const client = new Client({ name: "code-read-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`)));

    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((t) => t.name).sort()).toEqual(COMMAND_NAMES.map((n) => `codewatch__${n.replaceAll(".", "__")}`));
  });

  it("answers bad arguments over /rpc with HTTP 400 and DATAERR", async () => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/rpc/snapshot.list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: "many" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: 65 });
  });
});
