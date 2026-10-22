import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { deployHoldPath } from "./deploy-pause.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { landScenario } from "./test-support/land.js";

const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-held-"));
  dirs.push(dir);
  return dir;
}

async function healthOf(stateDir: string): Promise<Record<string, unknown>> {
  const scenario = landScenario();
  const server = await startFactoryServer({
    dbPath: join(tempDir(), "factory.sqlite3"),
    workflows: [scenario.workflow],
    routes: scenario.routes,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "a".repeat(40), behindMain: { status: () => 0, refresh: async () => undefined } },
    deployStateDir: stateDir,
  });
  servers.push(server);
  return z.record(z.string(), z.unknown()).parse(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json());
}

const deployHeldOf = async (stateDir: string): Promise<unknown> => (await healthOf(stateDir)).deployHeld;

const HOLD = { heldAt: "2026-01-01T00:00:00.000Z", reason: "holding for a migration" };

describe("/health deployHeld", () => {
  it("reports a hold set by hand, with its reason, beside a clear failure pause", async () => {
    const stateDir = tempDir();
    writeFileSync(deployHoldPath(stateDir), JSON.stringify(HOLD));

    const health = await healthOf(stateDir);

    expect(health.deployHeld).toEqual({ held: true, since: HOLD.heldAt, reason: HOLD.reason, source: null });
    expect(health.deployPaused).toMatchObject({ paused: false });
  });

  it("names the Morning item that set the hold", async () => {
    const stateDir = tempDir();
    writeFileSync(deployHoldPath(stateDir), JSON.stringify({ ...HOLD, source: "morning:seat-a:7" }));

    expect(await deployHeldOf(stateDir)).toEqual({ held: true, since: HOLD.heldAt, reason: HOLD.reason, source: "morning:seat-a:7" });
  });

  it("reads as not held when no hold file exists", async () => {
    expect(await deployHeldOf(tempDir())).toEqual({ held: false, since: null, reason: null, source: null });
  });

  it("still reads as held when the file exists but does not parse, as the deployer holds on its existence", async () => {
    const stateDir = tempDir();
    writeFileSync(deployHoldPath(stateDir), "{ half-written");

    expect(await deployHeldOf(stateDir)).toEqual({ held: true, since: null, reason: "deploy-hold.json exists but does not parse", source: null });
  });

  it("reads as held null with a reason, and still answers, when the file cannot be read", async () => {
    const stateDir = tempDir();
    mkdirSync(deployHoldPath(stateDir));

    expect(await deployHeldOf(stateDir)).toMatchObject({ held: null, since: null, reason: expect.stringMatching(/^deploy-hold\.json could not be read: /), source: null });
  });
});
