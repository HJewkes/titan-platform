import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, runCli, type CliDeps } from "./cli.js";
import { openFactoryHost } from "./host.js";
import { H1, REPO } from "./test-support/land.js";
import { BRANCH, callCommand, shepherdFixture } from "./test-support/shepherd.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return address.port;
}

/** A database holding one registered run for #1, closed again, so every CLI call below opens it afresh as a restart would. */
async function registeredDb(): Promise<{ dbPath: string; deps: CliDeps; port: string; runId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-merge-base-"));
  dirs.push(dir);
  const dbPath = join(dir, "state", "factory.sqlite3");
  const fixture = shepherdFixture();
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const host = openFactoryHost({ dbPath, workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  const registered = await callCommand<{ runId: string }>(host, fixture.routes, "shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
  if (!registered.ok) throw new Error(registered.error);
  host.close();
  return { dbPath, deps: { workflows: fixture.workflows, routes: fixture.routes, host: { gatePollMs: 5 }, logger: silentLogger }, port: String(await deadPort()), runId: registered.data.runId };
}

async function cli(argv: string[], deps: CliDeps): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: { AGENT_CHAT_NAME: "demo-planner" } }, deps);
  return { code, out, err };
}

describe("shepherd allow-merge-base", () => {
  it("records the exception on the run with the caller and the reason", async () => {
    const { dbPath, deps, port, runId } = await registeredDb();

    const allowed = await cli(["--db", dbPath, "shepherd", "allow-merge-base", `${REPO}#1`, "--reason", "the fix needs #12 from main", "--json", "--port", port], deps);

    expect(allowed.code).toBe(EXIT.OK);
    expect(JSON.parse(allowed.out)).toEqual({ runId, changed: true, exception: expect.objectContaining({ runId, reason: "the fix needs #12 from main", actor: "demo-planner" }) });
  });

  it("keeps the exception across a reopen until revoke-merge-base drops it", async () => {
    const { dbPath, deps, port } = await registeredDb();
    await cli(["--db", dbPath, "shepherd", "allow-merge-base", `${REPO}#1`, "--reason", "the fix needs #12 from main", "--port", port], deps);

    const revoked = await cli(["--db", dbPath, "shepherd", "revoke-merge-base", `${REPO}#1`, "--port", port], deps);
    const again = await cli(["--db", dbPath, "shepherd", "revoke-merge-base", `${REPO}#1`, "--json", "--port", port], deps);

    expect(revoked.out).toContain("exception revoked; fix rounds do not merge the base");
    expect(JSON.parse(again.out)).toMatchObject({ changed: false, exception: null });
  });

  it("refuses a PR that is not registered, recording nothing", async () => {
    const { dbPath, deps, port } = await registeredDb();

    const refused = await cli(["--db", dbPath, "shepherd", "allow-merge-base", `${REPO}#2`, "--reason", "the fix needs #12 from main", "--port", port], deps);

    expect(refused.code).toBe(EXIT.FAILURE);
    expect(refused.err).toContain(`${REPO}#2 is not registered with shepherd`);
  });

  it("refuses an allow with no --reason", async () => {
    const { dbPath, deps, port } = await registeredDb();

    const refused = await cli(["--db", dbPath, "shepherd", "allow-merge-base", `${REPO}#1`, "--port", port], deps);

    expect(refused.code).not.toBe(EXIT.OK);
  });
});
