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
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A database holding one registered run for #1, closed again, so every CLI call below opens it afresh as a restart would. */
async function registeredDb(cancelled = false): Promise<{ dbPath: string; deps: CliDeps; port: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-watch-"));
  dirs.push(dir);
  const dbPath = join(dir, "state", "factory.sqlite3");
  const fixture = shepherdFixture();
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const host = openFactoryHost({ dbPath, workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  const registered = await callCommand<{ runId: string }>(host, fixture.routes, "shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
  if (!registered.ok) throw new Error(registered.error);
  if (cancelled) {
    host.runtime.cancel(registered.data.runId, "test");
    await host.runtime.wait(registered.data.runId);
  }
  host.close();
  return { dbPath, deps: { workflows: fixture.workflows, routes: fixture.routes, host: { gatePollMs: 5 }, logger: silentLogger }, port: String(await deadPort()) };
}

async function cli(argv: string[], deps: CliDeps): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: { AGENT_CHAT_NAME: "demo-seat" } }, deps);
  return { code, out, err };
}

describe("shepherd watch", () => {
  it("records a watch with every event by default and lists it from a freshly opened database", async () => {
    const { dbPath, deps, port } = await registeredDb();

    const watched = await cli(["--db", dbPath, "shepherd", "watch", `${REPO}#1`, "--port", port], deps);
    const listed = await cli(["--db", dbPath, "shepherd", "watch", "--list", "--json", "--port", port], deps);

    expect(watched.code).toBe(EXIT.OK);
    expect(JSON.parse(listed.out)).toEqual({ changed: false, watches: [expect.objectContaining({ repo: REPO, pr: 1, seat: null, on: ["merged", "stopped", "gated"], actor: "demo-seat" })] });
  });

  it("keeps --on and --seat, and unwatch drops the watch", async () => {
    const { dbPath, deps, port } = await registeredDb();
    await cli(["--db", dbPath, "shepherd", "watch", `${REPO}#1`, "--on", "merged,stopped", "--seat", "ops-seat", "--port", port], deps);

    const listed = await cli(["--db", dbPath, "shepherd", "watch", "--list", "--port", port], deps);
    const unwatched = await cli(["--db", dbPath, "shepherd", "unwatch", `${REPO}#1`, "--port", port], deps);

    expect(listed.out).toContain(`${REPO}#1  on merged,stopped  to ops-seat (by demo-seat,`);
    expect(unwatched).toMatchObject({ code: EXIT.OK, out: "changed; no watches\n" });
  });

  it("exits 1 with the reason when the PR is not registered, and records nothing", async () => {
    const { dbPath, deps, port } = await registeredDb();

    const refused = await cli(["--db", dbPath, "shepherd", "watch", `${REPO}#2`, "--port", port], deps);
    const listed = await cli(["--db", dbPath, "shepherd", "watch", "--list", "--port", port], deps);

    expect(refused.code).toBe(EXIT.FAILURE);
    expect(refused.err).toBe(`error: ${REPO}#2 is not registered with shepherd, so nothing would report on it; register it first\n`);
    expect(listed.out).toBe("no watches\n");
  });

  it("exits 1 when the PR's run has already finished, since no digest would report it again", async () => {
    const { dbPath, deps, port } = await registeredDb(true);

    const refused = await cli(["--db", dbPath, "shepherd", "watch", `${REPO}#1`, "--port", port], deps);

    expect(refused.code).toBe(EXIT.FAILURE);
    expect(refused.err).toMatch(/already finished \(run \S+ is cancelled\), so there is nothing left to watch/);
  });

  it.each([
    ["an unknown event", ["acme/widgets#1", "--on", "merged,landed"], "unknown event landed"],
    ["no ref and no --list", [], "watch needs owner/repo#N, or --list"],
  ])("exits 2 on %s", async (_case, args, message) => {
    const result = await cli(["shepherd", "watch", ...args], { workflows: [], routes: [] });

    expect(result.code).toBe(EXIT.USAGE);
    expect(result.err).toContain(message);
  });
});
