import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StepRoute } from "@titan-design/workflow";
import { EXIT, runCli, type CliDeps } from "./cli.js";
import { defineWorkflow } from "./definition.js";
import { openFactoryHost } from "./host.js";
import type * as Host from "./host.js";

vi.mock("./host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Host>();
  return { ...actual, openFactoryHost: vi.fn(actual.openFactoryHost) };
});

const REMOTE = "http://127.0.0.1:7410";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
beforeEach(() => void vi.mocked(openFactoryHost).mockClear());

const routes: StepRoute[] = [{ match: "ship", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: "shipped" }) } }];
const approval = defineWorkflow({
  name: "approval",
  steps: [
    { id: "approve-publish", kind: "assisted" },
    { id: "ship", kind: "dispatch" },
  ],
  run: async (ctx) => {
    await ctx.assisted("approve-publish", "Publish the draft?", { schema: z.object({ approve: z.literal(true) }), brief: { summary: "Publish the draft?", evidenceRef: "$ git log -1" } });
    await ctx.dispatch("ship", "ship");
  },
});
const deps: CliDeps = { workflows: [approval], routes, host: { gatePollMs: 10 }, presence: async () => undefined };

/** A home whose config file holds `config`; the database path is returned and never created by the test. */
function home(config: object): { env: NodeJS.ProcessEnv; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "factory-remote-"));
  dirs.push(dir);
  mkdirSync(join(dir, "config", "titan-factory"), { recursive: true });
  writeFileSync(join(dir, "config", "titan-factory", "config.json"), JSON.stringify(config));
  return { env: { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") }, dbPath: join(dir, "state", "factory.sqlite3") };
}

async function cli(env: NodeJS.ProcessEnv, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env }, deps);
  return { code, out, err };
}

async function pausedRun(dbPath: string): Promise<string> {
  const host = openFactoryHost({ dbPath, workflows: [approval], routes, gatePollMs: 10 });
  const runId = host.runtime.start("approval");
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  host.close();
  vi.mocked(openFactoryHost).mockClear();
  return runId;
}

async function deadPort(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return String(port);
}

describe("a host whose config names a remoteFactory", () => {
  it("refuses a local resolve when remoteFactory is set", async () => {
    const { env } = home({ remoteFactory: REMOTE });

    const { code, err } = await cli(env, "gate", "resolve", "run-1", "approve-publish", "--json", '{"approve":true}');

    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain(REMOTE);
    expect(err).toContain("this host's database is frozen");
  });

  it("refuses a resolve aimed at an explicit --db too", async () => {
    const { env, dbPath } = home({ remoteFactory: REMOTE });

    const { code } = await cli(env, "--db", dbPath, "gate", "resolve", "run-1", "approve-publish", "--json", '{"approve":true}');

    expect(code).toBe(EXIT.USAGE);
    expect(existsSync(dbPath)).toBe(false);
  });

  it.each([
    ["gate resolve", async () => ["gate", "resolve", "run-1", "approve-publish", "--json", '{"approve":true}']],
    ["resume", async () => ["resume"]],
    ["land with no serve answering", async () => ["land", "acme/web#1", "--port", await deadPort()]],
    ["shepherd resync with no serve answering", async () => ["shepherd", "resync", "--port", await deadPort()]],
  ])("opens no database when it refuses %s", async (_verb, argv) => {
    const { env, dbPath } = home({ remoteFactory: REMOTE });

    const { code, err } = await cli(env, ...(await argv()));

    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("this host's database is frozen");
    expect(openFactoryHost).not.toHaveBeenCalled();
    expect(existsSync(dbPath)).toBe(false);
  });

  it("resolves locally when remoteFactory is unset", async () => {
    const { env, dbPath } = home({});
    const runId = await pausedRun(dbPath);

    const { code, out } = await cli(env, "--db", dbPath, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true}');

    expect(code).toBe(EXIT.OK);
    expect(out).toBe(`resolved ${runId}/approve-publish\n`);
    expect(openFactoryHost).toHaveBeenCalledTimes(1);
  });
});
