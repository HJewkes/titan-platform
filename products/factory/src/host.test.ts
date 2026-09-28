import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EXIT, runCli, type CliDeps } from "./cli.js";
import { defineWorkflow } from "./definition.js";
import { openFactoryHost } from "./host.js";
import type { StepRoute } from "./routed-runner.js";

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
    await ctx.assisted("approve-publish", "Publish the draft?", { schema: z.object({ approve: z.literal(true) }) });
    await ctx.dispatch("ship", "ship");
  },
});

const deps: CliDeps = { workflows: [approval], routes, host: { gatePollMs: 10 } };

async function cli(dbPath: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(["--db", dbPath, ...argv], { stdout: (t) => (out += t), stderr: (t) => (err += t), env: {} }, deps);
  return { code, out, err };
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
});
