import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { deployPausePath } from "./deploy-pause.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { landScenario } from "./test-support/land.js";

const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-paused-"));
  dirs.push(dir);
  return dir;
}

async function deployPausedOf(stateDir: string): Promise<unknown> {
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
  const body = z.record(z.string(), z.unknown()).parse(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json());
  return body.deployPaused;
}

const PAUSE = { pausedAt: "2026-01-01T00:00:00.000Z", target: "b".repeat(40), from: "a".repeat(40), why: "restarted build failed its watch", rollback: "verified" };

describe("/health deployPaused", () => {
  it("reports the pause, its reason and the rollback while deploy-pause.json is on disk", async () => {
    const stateDir = tempDir();
    writeFileSync(deployPausePath(stateDir), JSON.stringify(PAUSE));

    expect(await deployPausedOf(stateDir)).toEqual({
      paused: true,
      since: PAUSE.pausedAt,
      reason: PAUSE.why,
      lastRollback: { target: PAUSE.target, from: PAUSE.from, status: "verified" },
    });
  });

  it("reads as not paused when no pause file exists", async () => {
    expect(await deployPausedOf(tempDir())).toEqual({ paused: false, since: null, reason: null, lastRollback: null });
  });

  it("still reads as paused when the file exists but does not parse, as the deployer holds on its existence", async () => {
    const stateDir = tempDir();
    writeFileSync(deployPausePath(stateDir), "{ half-written");

    expect(await deployPausedOf(stateDir)).toEqual({ paused: true, since: null, reason: "deploy-pause.json exists but does not parse", lastRollback: null });
  });

  it("reads as paused null with a reason, and still answers, when the file cannot be read", async () => {
    const stateDir = tempDir();
    mkdirSync(deployPausePath(stateDir));

    expect(await deployPausedOf(stateDir)).toMatchObject({ paused: null, since: null, reason: expect.stringMatching(/^deploy-pause\.json could not be read: /), lastRollback: null });
  });
});
