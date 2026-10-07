import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateMigration } from "@titan-design/hitl/sqlite";
import { appliedVersions, openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { workflowMigration, workflowOwnershipMigration } from "@titan-design/workflow";
import { z } from "zod";
import { EXIT, runCli, type CliDeps } from "./cli.js";
import { defineWorkflow } from "./definition.js";
import { openFactoryHost } from "./host.js";
import type { StepRoute } from "@titan-design/workflow";
import { OWNER } from "./test-support/resolver.js";
import { SHEPHERD_MIGRATIONS } from "./workflows.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-host-"));
  dirs.push(dir);
  return join(dir, "state", "factory.sqlite3");
}

const shipped: string[] = [];
const routes: StepRoute[] = [{ match: "ship", onRestart: "repeat", runner: { run: async (input) => (shipped.push(input.runId), { ok: true, output: "shipped" }) } }];

const approval = defineWorkflow({
  name: "approval",
  steps: [
    { id: "approve-publish", kind: "assisted" },
    { id: "ship", kind: "dispatch" },
  ],
  run: async (ctx) => {
    const brief = { summary: "Publish the draft? Nothing else is waiting on it.", evidenceRef: "$ git log -1" };
    await ctx.assisted("approve-publish", "Publish the draft?", { schema: z.object({ approve: z.literal(true) }), brief });
    await ctx.dispatch("ship", "ship");
  },
});

const deps: CliDeps = { workflows: [approval], routes, host: { gatePollMs: 10 }, presence: async () => undefined };

async function cli(dbPath: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  return cliWithEnv(dbPath, {}, ...argv);
}

async function cliWithEnv(dbPath: string, env: NodeJS.ProcessEnv, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(["--db", dbPath, ...argv], { stdout: (t) => (out += t), stderr: (t) => (err += t), env }, deps);
  return { code, out, err };
}

function gateAt(dbPath: string, id: string) {
  const host = openFactoryHost({ dbPath, workflows: [approval], routes });
  try {
    return host.gates.get(id);
  } finally {
    host.close();
  }
}

async function pausedRun(dbPath: string): Promise<string> {
  const host = openFactoryHost({ dbPath, workflows: [approval], routes, gatePollMs: 10 });
  const runId = host.runtime.start("approval");
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  host.close();
  return runId;
}

describe("titan-factory resume and gate resolve", () => {
  it("resume hydrates a paused run and prints its pending gate with the resolve command", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);

    const { code, out } = await cli(dbPath, "resume");

    expect(code).toBe(EXIT.OK);
    expect(out).toContain(`resumed ${runId} approval: paused`);
    expect(out).toContain(`gate ${runId}/approve-publish: Publish the draft?`);
    expect(out).toContain(`resolve: titan-factory gate resolve ${runId} approve-publish --json '<payload>'`);
  });

  it("gate resolve refuses a payload the stored schema rejects and leaves the gate pending", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);

    const { code, err } = await cli(dbPath, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":false}');

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("does not match its schema");
    const host = openFactoryHost({ dbPath, workflows: [approval], routes });
    expect(host.gates.get(`${runId}/approve-publish`)?.status).toBe("pending");
    host.close();
  });

  it("gate resolve rejects a payload that is not a JSON object", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);

    const { code, err } = await cli(dbPath, "gate", "resolve", runId, "approve-publish", "--json", "[true]");

    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("must be a JSON object");
  });

  it("a resolved gate lets the next resume finish the run exactly once", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);

    const resolved = await cli(dbPath, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true}');
    const resumed = await cli(dbPath, "resume");
    const again = await cli(dbPath, "resume");

    expect(resolved).toMatchObject({ code: EXIT.OK, out: `resolved ${runId}/approve-publish\n` });
    expect(resumed.out).toBe(`resumed ${runId} approval: completed\n`);
    expect(again.out).toBe("nothing to resume\n");
    expect(shipped.filter((id) => id === runId)).toHaveLength(1);
  });

  it("gate resolve repeated with the same answer after the run took it exits 0 instead of looking for a next gate", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);
    await cli(dbPath, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true}');
    await cli(dbPath, "resume");

    const repeated = await cli(dbPath, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true}');

    expect(repeated).toMatchObject({ code: EXIT.OK, out: `already resolved ${runId}/approve-publish with this answer\n`, err: "" });
  });

  it("gate resolve repeated with a different answer after the run took it still fails", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);
    await cli(dbPath, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true}');
    await cli(dbPath, "resume");

    const changed = await cli(dbPath, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true,"note":"again"}');

    expect(changed.code).toBe(EXIT.FAILURE);
    expect(changed.err).toContain(`no gate with id ${runId}/approve-publish:1`);
  });

  it("gate resolve from an agent-chat agent's shell is refused and the gate stays pending", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);

    const { code, err } = await cliWithEnv(dbPath, { AGENT_CHAT_AGENT_ID: "agent-1" }, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true}');

    expect(code).toBe(EXIT.FAILURE);
    expect(err).toContain("refused a resolution by coordinator");
    expect(gateAt(dbPath, `${runId}/approve-publish`)).toMatchObject({ status: "pending", resolvedBy: undefined });
  });

  it("gate resolve refuses a proof passed as a flag and the gate stays pending", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);

    const proof = "0b6f2c1e-6f1d-4c3a-9e1b-2d4c6a8e0f13";
    const { code, err } = await cliWithEnv(dbPath, { AGENT_CHAT_AGENT_ID: "agent-1" }, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true}', "--proof", proof);

    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("unknown option '--proof'");
    expect(gateAt(dbPath, `${runId}/approve-publish`)).toMatchObject({ status: "pending", resolvedBy: undefined });
  });

  it("gate resolve from the owner's terminal records the owner on the factory-cli channel, even with CLAUDECODE set", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);

    const { code } = await cliWithEnv(dbPath, { CLAUDECODE: "1" }, "gate", "resolve", runId, "approve-publish", "--json", '{"approve":true}');

    expect(code).toBe(EXIT.OK);
    expect(gateAt(dbPath, `${runId}/approve-publish`)).toMatchObject({
      status: "resolved",
      resolvedBy: { class: "owner-terminal", id: userInfo().username, channel: "factory-cli" },
    });
  });
});

describe("gate resolver migration", () => {
  it("a factory database created before the resolver migration gains the resolved_by column and its trigger when the host opens it", () => {
    const dbPath = dbFile();
    mkdirSync(dirname(dbPath), { recursive: true });
    const preResolver = openDatabase(dbPath);
    runMigrations(preResolver, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), ...SHEPHERD_MIGRATIONS]);
    preResolver.close();
    const tenantRoutes = Object.assign([...routes], { database: { extraMigrations: SHEPHERD_MIGRATIONS, bind: () => () => undefined } });

    openFactoryHost({ dbPath, workflows: [approval], routes: tenantRoutes }).close();

    const db = openDatabase(dbPath);
    const column = db.prepare("SELECT 1 FROM pragma_table_info('hitl_gate') WHERE name = 'resolved_by'").get();
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%resolver_required%'").all();
    const versions = appliedVersions(db);
    db.close();
    expect(column).toBeDefined();
    expect(triggers.length).toBeGreaterThan(0);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });
});

describe("gate briefs", () => {
  const bare = defineWorkflow({
    name: "bare",
    steps: [{ id: "approve-publish", kind: "assisted" }],
    run: async (ctx) => void (await ctx.assisted("approve-publish", "Publish the draft?")),
  });

  it("the factory host refuses a gate with no brief", async () => {
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [bare], routes: [], gatePollMs: 10 });
    const runId = host.runtime.start("bare");

    await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("failed"));
    expect(host.runtime.status(runId)?.error).toMatch(/brief is invalid: summary is required; evidenceRef is required/);
    expect(host.gates.listPending()).toEqual([]);
    host.close();
  });

  it("stores a gate's brief beside its prompt", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);

    const gate = gateAt(dbPath, `${runId}/approve-publish`);

    expect(gate).toMatchObject({ summary: "Publish the draft? Nothing else is waiting on it.", evidenceRef: "$ git log -1" });
  });
});

describe("FactoryHost.adopt", () => {
  it("keeps driving the runs it claimed after it returns, so a later answer finishes them", async () => {
    const dbPath = dbFile();
    const runId = await pausedRun(dbPath);
    const host = openFactoryHost({ dbPath, workflows: [approval], routes, gatePollMs: 10 });

    const adopted = await host.adopt();
    host.runtime.signal(runId, "approve-publish", { approve: true }, OWNER);

    expect(adopted).toEqual([runId]);
    await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("completed"));
    expect(shipped.filter((id) => id === runId)).toHaveLength(1);
    host.close();
  });
});

describe("route coverage", () => {
  it("refuses to register a workflow whose dispatch step has no route, before any run starts", () => {
    const create = () => openFactoryHost({ dbPath: ":memory:", workflows: [approval], routes: [] });

    expect(create).toThrow(/no route for ship/);
  });
});
