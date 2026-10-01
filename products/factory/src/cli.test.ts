import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { daemonPaths, probeHealth, readPidFile, silentLogger } from "@titan-design/daemon";
import { fakeGitHub, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT, runCli, type CliDeps } from "./cli.js";
import { openFactoryHost } from "./host.js";
import type { StepRoute } from "@titan-design/workflow";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { H1, REPO } from "./test-support/land.js";
import { landPrRoutes, landPrWorkflow } from "./workflows/land-pr.js";

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-cli-"));
  dirs.push(dir);
  return join(dir, "state", "factory.sqlite3");
}

/** land-pr against PR #1 on a fake repo whose checks pass; `hangAt` makes that step's runner never settle. */
function landDeps(hangAt?: string): CliDeps & { routes: readonly StepRoute[] } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  const routes = landPrRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms) });
  return { workflows: [landPrWorkflow()], routes: hangAt ? hanging(routes, hangAt) : routes, host: { gatePollMs: 5 }, logger: silentLogger };
}

function hanging(routes: StepRoute[], stepId: string): StepRoute[] {
  return routes.map((route) => ({
    ...route,
    runner: { run: (input) => (input.stepId === stepId ? new Promise(() => undefined) : route.runner.run(input)) },
  }));
}

async function cli(argv: string[], deps: CliDeps): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: {} }, deps);
  return { code, out, err };
}

async function serve(dbPath: string, deps: ReturnType<typeof landDeps>): Promise<FactoryServer> {
  const server = await startFactoryServer({ dbPath, workflows: deps.workflows, routes: deps.routes, port: 0, runtimeId: "serve-host", logger: silentLogger, gatePollMs: 5 });
  cleanups.push(() => server.close());
  return server;
}

/** A loopback port nothing listens on: bind an ephemeral one, then free it. */
async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function runIdIn(out: string): string {
  return /^run (\S+) land-pr/m.exec(out)?.[1] ?? "";
}

describe("titan-factory land", () => {
  it("with a server up, hands the PR to it and returns while the run is still in flight on the server's lease", async () => {
    const dbPath = dbFile();
    const deps = landDeps("land-rules");
    const server = await serve(dbPath, deps);

    const { code, out } = await cli(["--db", dbPath, "land", `${REPO}#1`, "--task", "demo/T-1", "--port", String(server.port)], deps);

    const run = server.host.runtime.status(runIdIn(out));
    expect(code).toBe(EXIT.OK);
    expect(out).toContain(`on titan-factory serve (port ${server.port})`);
    expect(run).toMatchObject({ status: "running", params: { repo: REPO, pr: "1", task: "demo/T-1" }, owner: { runtimeId: "serve-host" } });
  });

  it("with a server up, landing the same PR twice leaves one run", async () => {
    const dbPath = dbFile();
    const deps = landDeps("land-rules");
    const server = await serve(dbPath, deps);
    const argv = ["--db", dbPath, "land", `${REPO}#1`, "--port", String(server.port)];

    const first = await cli(argv, deps);
    const second = await cli(argv, deps);

    expect(runIdIn(second.out)).toBe(runIdIn(first.out));
    expect(second.out).toContain("(already unfinished)");
    expect(server.host.runtime.list().map((run) => run.id)).toEqual([runIdIn(first.out)]);
  });

  it("with no server, drives the run here until its gate, releases it, and says to run serve", async () => {
    const dbPath = dbFile();

    const { code, out } = await cli(["--db", dbPath, "land", `${REPO}#1`, "--port", String(await deadPort())], landDeps());

    const { workflows, routes } = landDeps();
    const host = openFactoryHost({ dbPath, workflows, routes });
    cleanups.push(() => host.close());
    const run = host.runtime.status(runIdIn(out));
    expect(code).toBe(EXIT.OK);
    expect(out).toContain("resolve: titan-factory gate resolve");
    expect(out).toContain("run titan-factory serve to keep it alive");
    expect(run?.status).toBe("paused");
    expect(run?.owner).toBeUndefined();
    expect(host.pendingGates().map((pending) => pending.stepId)).toEqual(["approve-merge"]);
  });

  it.each(["octo/demo", "octo/../demo#1", "octo/demo#1.5", "octo/demo/extra#1"])("refuses %s with a usage error and starts nothing", async (ref) => {
    const dbPath = dbFile();

    const { code, err } = await cli(["--db", dbPath, "land", ref, "--port", String(await deadPort())], landDeps());

    expect(code).toBe(EXIT.USAGE);
    expect(err).toMatch(/expected owner\/repo#N/);
  });
});

describe("titan-factory serve", () => {
  it("serves the database until stopped, and land hands runs to it", async () => {
    const dbPath = dbFile();
    const stop = new AbortController();
    const deps = { ...landDeps("land-rules"), stop: stop.signal };
    const serving = cli(["--db", dbPath, "serve", "--port", "0"], deps);
    const port = await vi.waitFor(async () => (await readPidFile(daemonPaths(dirname(dbPath))))!.meta.port);

    const landed = await cli(["--db", dbPath, "land", `${REPO}#1`, "--port", String(port)], deps);
    stop.abort();

    expect(landed.out).toContain(`on titan-factory serve (port ${port})`);
    expect((await serving).code).toBe(EXIT.OK);
    expect(await probeHealth(port)).toBeNull();
  });
});
