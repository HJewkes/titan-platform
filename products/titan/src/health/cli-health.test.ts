import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHealthStore, readSamples, type HealthSample } from "@titan-design/health";
import { runCli } from "../cli.js";

const SERVE_PID = 2_908_352;

// The shape serve's /health answered with after tp#870.
const factoryHealth = {
  ok: true,
  pid: SERVE_PID,
  port: 7410,
  uptime_ms: 61_000,
  startedAt: "2026-10-09T08:00:00.000Z",
  uptimeSeconds: 61,
  restartCount: 3,
  uncleanStartsTotal: 1,
  restartsToday: 2,
  build: { sha: "abc1234" },
};

let dir: string;
let server: Server;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "titan-cli-health-"));
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(factoryHealth)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await mkdir(join(dir, "config", "titan"), { recursive: true });
  await writeFile(
    join(dir, "config", "titan", "host.json"),
    JSON.stringify({ health: { targets: [{ name: "factory", url: `http://127.0.0.1:${port}/health` }] } }),
  );
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

async function writeServePid(pid: number): Promise<void> {
  await mkdir(join(dir, "state", "titan-factory"), { recursive: true });
  await writeFile(join(dir, "state", "titan-factory", "daemon.pid"), String(pid));
}

async function sample(...extra: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") };
  const code = await runCli(["health", "sample", ...extra], {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env,
    home: dir,
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

function storedRows(dbPath: string): HealthSample[] {
  const db = openHealthStore(dbPath, { readonly: true });
  try {
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 60_000);
    return [...readSamples(db, "factory", from, to), ...readSamples(db, "titan-health-sampler", from, to)];
  } finally {
    db.close();
  }
}

describe("titan health sample", () => {
  it("stores the factory's restart fields in observed and a self row", async () => {
    await writeServePid(SERVE_PID);
    const db = join(dir, "health.sqlite3");

    const result = await sample("--db", db);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const [factory, self] = storedRows(db);
    expect(factory).toMatchObject({ target: "factory", kind: "http", status: "pass" });
    expect(factory?.observed).toMatchObject({
      restartCount: 3,
      uncleanStartsTotal: 1,
      restartsToday: 2,
      startedAt: "2026-10-09T08:00:00.000Z",
      "build.sha": "abc1234",
    });
    expect(self).toMatchObject({ kind: "self", observed: expect.objectContaining({ targets: 1 }) });
  });

  it("stores a fail when the pid file names another process, and still exits 0", async () => {
    await writeServePid(SERVE_PID + 1);
    const db = join(dir, "health.sqlite3");

    const result = await sample("--db", db);

    expect(result.code).toBe(0);
    expect(storedRows(db)[0]).toMatchObject({ status: "fail", output: expect.stringMatching(/^identity:/) });
  });

  it("defaults the store to the titan state dir", async () => {
    await writeServePid(SERVE_PID);

    const result = await sample();

    expect(result.code).toBe(0);
    expect(storedRows(join(dir, "state", "titan", "health.sqlite3"))).toHaveLength(2);
  });

  it("exits 2 naming the path when the store cannot be opened", async () => {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "");
    const db = join(blocker, "health.sqlite3");

    const result = await sample("--db", db);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(db);
  });
});
