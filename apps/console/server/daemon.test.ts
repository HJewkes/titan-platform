import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { createRpcClient, liveSource, snapshotKey } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "./commands.js";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { fixtureAnswer } from "./fixtures.js";
import { createConsoleRegistry, recordFirstPaint } from "./registry.js";
import { closedPort, startFakeDaemon, type FakeDaemon } from "./test-support.js";
import { createSources } from "./upstreams.js";

let dir: string;
let activeWork: FakeDaemon;
let config: ConsoleConfig;
let handle: DaemonHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-daemon-"));
  activeWork = await startFakeDaemon({ ok: true, version: "9.9.9", index: {} }, fixtureAnswer);
  config = {
    port: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort: activeWork.port,
    agentChatPort: await closedPort(),
    agentChatTokenPath: path.join(dir, "ui.token"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
  };
  await writeFile(config.sessionGraphPath, "synthetic");
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await activeWork.close();
  await rm(dir, { recursive: true, force: true });
});

const origin = (): string => `http://127.0.0.1:${handle!.port}`;

describe("the console daemon", () => {
  it("answers upstreams.health through a typed client with all three upstreams", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const { upstreams, checkedAt } = await client.call("upstreams.health");
    expect(Number.isNaN(Date.parse(checkedAt))).toBe(false);
    expect(upstreams.map(({ id, reachable }) => ({ id, reachable }))).toEqual([
      { id: "work", reachable: true },
      { id: "agents", reachable: false },
      { id: "sessions", reachable: true },
    ]);
  });

  it("answers work.portfolio from the active-work daemon it fronts", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const client = createRpcClient<ConsoleCommands>(liveSource({ origin: origin() }));
    const { initiatives } = await client.call("work.portfolio");
    expect(initiatives).toHaveLength(5);
    const detail = await client.call("work.initiative", { slug: "lantern-docs" });
    expect(detail.tasks.map((task) => task.id)).toEqual(["LD-3"]);
  });

  it("lists the upstream targets on /health without probing them", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    const health = (await (await fetch(`${origin()}/health`)).json()) as { ok: boolean; upstreams: Array<{ id: string; target: string }> };
    expect(health.ok).toBe(true);
    expect(health.upstreams.map((u) => u.id)).toEqual(["work", "agents", "sessions"]);
    expect(health.upstreams[0]?.target).toBe(`http://127.0.0.1:${activeWork.port}`);
  });

  it("serves the built app shell at / and for a client route", async () => {
    const page = path.join(dir, "index.html");
    await writeFile(page, "<!doctype html><title>console shell</title>");
    handle = await startConsoleDaemon({ config, staticRoot: page, logger: silentLogger });
    for (const route of ["/", "/sessions"]) {
      const res = await fetch(`${origin()}${route}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("console shell");
    }
  });

  it("refuses a second console over the same state directory", async () => {
    handle = await startConsoleDaemon({ config, logger: silentLogger });
    await expect(startConsoleDaemon({ config, logger: silentLogger })).rejects.toThrow(/already running/);
  });
});

describe("the first-paint snapshot", () => {
  it("records upstreams.health so an exported page needs no daemon", async () => {
    const snapshot = await recordFirstPaint(createConsoleRegistry(createSources(config)));
    expect(snapshot.calls[snapshotKey("upstreams.health", {})]).toMatchObject({ ok: true });
  });
});
