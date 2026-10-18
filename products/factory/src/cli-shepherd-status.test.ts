import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, runCli, type CliDeps } from "./cli.js";
import { openFactoryHost } from "./host.js";
import { REPO } from "./test-support/land.js";
import { callCommand, shepherdFixture } from "./test-support/shepherd.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function cli(argv: string[], deps: CliDeps): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: {} }, deps);
  return { code, out, err };
}

/** A loopback port nothing listens on, so `status` reads the database directly. */
async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return address.port;
}

/** One live run and one cancelled run in a fresh database. */
async function liveAndCancelled(): Promise<{ dbPath: string; deps: CliDeps; runIds: string[] }> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "factory-cli-")), "state", "factory.sqlite3");
  dirs.push(join(dbPath, "..", ".."));
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath, workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  const runIds: string[] = [];
  for (const branch of ["agent-chat/pc-live", "agent-chat/pc-gone"]) {
    const run = await callCommand<{ runId: string }>(host, fixture.routes, "shepherd.register", { repo: REPO, branch, task: "demo/TP-1", implementer: "impl-a" });
    if (!run.ok) throw new Error(run.error);
    runIds.push(run.data.runId);
  }
  host.runtime.cancel(runIds[1]!, "test");
  await host.runtime.wait(runIds[1]!);
  host.close();
  return { dbPath, deps: { workflows: fixture.workflows, routes: fixture.routes, host: { gatePollMs: 5 }, logger: silentLogger }, runIds };
}

describe("shepherd status --all", () => {
  it("is accepted and lists every run, the cancelled one included", async () => {
    const { dbPath, deps, runIds } = await liveAndCancelled();

    const status = await cli(["--db", dbPath, "shepherd", "status", "--all", "--json", "--port", String(await deadPort())], deps);

    expect(status.err).toBe("");
    expect(status.code).toBe(EXIT.OK);
    const rows: unknown = JSON.parse(status.out);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining(runIds.map((runId) => expect.objectContaining({ runId }))));
  });

  it("without --all lists only the live run", async () => {
    const { dbPath, deps, runIds } = await liveAndCancelled();

    const status = await cli(["--db", dbPath, "shepherd", "status", "--json", "--port", String(await deadPort())], deps);

    expect(JSON.parse(status.out)).toEqual([expect.objectContaining({ runId: runIds[0] })]);
  });

  it("a --phase naming a finished phase asks for finished runs without --all", async () => {
    const { dbPath, deps, runIds } = await liveAndCancelled();

    const status = await cli(["--db", dbPath, "shepherd", "status", "--phase", "cancelled", "--json", "--port", String(await deadPort())], deps);

    expect(JSON.parse(status.out)).toEqual([expect.objectContaining({ runId: runIds[1], phase: "cancelled" })]);
  });
});
