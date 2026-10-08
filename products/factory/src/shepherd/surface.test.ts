import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { openFactoryHost } from "../host.js";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { deployWatch, type DeployWatch } from "../deploy-watch.js";
import { H1, REPO } from "../test-support/land.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { BRANCH, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";

const SHEPHERD_TOOLS = ["register", "status", "list", "timeline", "hold", "release", "merge"].map((verb) => `shepherd__${verb}`);
const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-surface-"));
  dirs.push(dir);
  return join(dir, "state", "factory.sqlite3");
}

async function serve(fixture: ShepherdFixture, deployWatch?: DeployWatch): Promise<FactoryServer> {
  const server = await startFactoryServer({
    deployWatch,
    dbPath: dbFile(),
    workflows: fixture.workflows,
    routes: fixture.routes,
    gatePollMs: 5,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
  });
  cleanups.push(() => server.close());
  return server;
}

async function post(port: number, path: string, body: unknown): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", [CLIENT_HEADER]: "surface-test" },
    body: JSON.stringify(body),
  });
  return res.text();
}

/** The streamable HTTP transport may answer as one SSE event; its data line is the JSON-RPC response. */
function jsonRpcResult(text: string): { tools: { name: string }[] } {
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return (JSON.parse(data ? data.slice("data: ".length) : text) as { result: { tools: { name: string }[] } }).result;
}

async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function cli(argv: string[], fixture: ShepherdFixture): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: {} };
  const code = await runCli(argv, io, { workflows: fixture.workflows, routes: fixture.routes, host: { gatePollMs: 5 }, logger: silentLogger });
  return { code, out, err };
}

/** Leaves a registration in the database file whose run failed, the way a timed-out ci-wait would. */
async function seedFailedRegistration(fixture: ShepherdFixture, dbPath: string): Promise<string> {
  const host = openFactoryHost({ dbPath, workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  try {
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", branch: BRANCH, policy: JSON.stringify(OWNER_GATE_POLICY), task: "demo/T-1", after: "not json" });
    await host.runtime.wait(runId);
    fixture.routes.shepherd!.store.get().register({ repo: REPO, pr: 1, branch: BRANCH, runId, task: "demo/T-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    return runId;
  } finally {
    host.close();
  }
}

const register = { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" };

describe("shepherd surfaces on titan-factory serve", () => {
  it("MCP ListTools names every shepherd command unprefixed, and no tool can resolve a gate", async () => {
    const server = await serve(shepherdFixture());

    const { tools } = jsonRpcResult(await post(server.port, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([...SHEPHERD_TOOLS, "factory__land"]));
    expect(names.filter((name) => /resolve/i.test(name))).toEqual([]);
  });

  it("/rpc/shepherd.register starts a run, and titan-factory shepherd status --json reads it from the server", async () => {
    const fixture = shepherdFixture({ frozen: true });
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const server = await serve(fixture);

    const registered = JSON.parse(await post(server.port, "/rpc/shepherd.register", register)) as { ok: boolean; data: { runId: string; created: boolean } };
    const status = await cli(["shepherd", "status", `${REPO}#1`, "--json", "--port", String(server.port)], fixture);

    expect(registered).toMatchObject({ ok: true, data: { created: true } });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject([{ repo: REPO, pr: 1, runId: registered.data.runId }]);
  });
});

describe("the deploy block on shepherd status", () => {
  const SHA = "a".repeat(40);
  const ASKED = `2026-10-07T10:00:00Z service deploy --expect ${"b".repeat(40)}\n`;
  const lagging = (): DeployWatch =>
    deployWatch({ readLog: () => ASKED, runningSha: () => SHA, indexLock: async () => ({ state: "absent", path: "" }), now: () => Date.parse("2026-10-07T12:00:00Z") });

  async function served(): Promise<{ fixture: ShepherdFixture; port: string }> {
    const fixture = shepherdFixture({ frozen: true });
    const watch = lagging();
    const server = await serve(fixture, watch);
    await watch.tick();
    return { fixture, port: String(server.port) };
  }

  it("rides along as { rows, deploy } under --json --deploy, while bare --json stays the row array", async () => {
    const { fixture, port } = await served();

    const withDeploy = await cli(["shepherd", "status", "--json", "--deploy", "--port", port], fixture);
    const bare = await cli(["shepherd", "status", "--json", "--port", port], fixture);

    expect(JSON.parse(withDeploy.out)).toMatchObject({ rows: [], deploy: { alarm: true, behind: 1, behindMinutes: 120, runningSha: SHA, consecutiveRefusals: 0, lastRefusal: null } });
    expect(JSON.parse(bare.out)).toEqual([]);
  });

  it("ends the human view with the deploy line", async () => {
    const { fixture, port } = await served();

    const status = await cli(["shepherd", "status", "--port", port], fixture);

    expect(status.out.split("\n").filter(Boolean).at(-1)).toMatch(new RegExp(`^deploy: running ${SHA}, 1 asked deploy\\(s\\) not landed, .*ALARM`));
  });
});

describe("titan-factory shepherd with no server", () => {
  it("register exits 69 with one stderr line naming the port and --offline, and records no run", async () => {
    const fixture = shepherdFixture({ frozen: true });
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const common = ["--db", dbFile(), "shepherd"];
    const port = String(await deadPort());

    const result = await cli([...common, "register", `${REPO}#1`, "--task", "demo/T-1", "--implementer", "impl-a", "--port", port], fixture);
    const list = await cli([...common, "list", "--state", "all", "--json", "--port", port], fixture);

    expect(result.code).toBe(69);
    expect(result.out).toBe("");
    expect(result.err.split("\n").filter(Boolean)).toEqual([expect.stringMatching(new RegExp(`port ${port}.*--offline`))]);
    expect(JSON.parse(list.out)).toEqual([]);
  });

  it("register --offline records the run here with today's output", async () => {
    const fixture = shepherdFixture({ frozen: true });
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const port = String(await deadPort());

    const result = await cli(["--db", dbFile(), "shepherd", "register", `${REPO}#1`, "--task", "demo/T-1", "--implementer", "impl-a", "--offline", "--port", port], fixture);

    expect(result.code).toBe(0);
    expect(result.out).toMatch(new RegExp(`^run \\S+ shepherd-pr ${REPO}#1 \\(${BRANCH}\\): `));
    expect(result.err).toBe(`no titan-factory serve answered on port ${port}, so the run was recorded here; titan-factory serve drives it\n`);
  });

  it("status reads an offline registration from the database", async () => {
    const fixture = shepherdFixture({ frozen: true });
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const common = ["--db", dbFile(), "shepherd"];
    const port = String(await deadPort());

    const registered = await cli([...common, "register", `${REPO}#1`, "--task", "demo/T-1", "--implementer", "impl-a", "--offline", "--json", "--port", port], fixture);
    const status = await cli([...common, "status", `${REPO}#1`, "--json", "--port", port], fixture);

    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject([{ repo: REPO, pr: 1, runId: JSON.parse(registered.out).runId }]);
  });

  it("register --offline against the database twice returns the same run", async () => {
    const fixture = shepherdFixture({ frozen: true });
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const common = ["--db", dbFile(), "shepherd"];
    const port = String(await deadPort());
    const args = [`${REPO}#1`, "--task", "demo/T-1", "--implementer", "impl-a", "--offline", "--json", "--port", port];

    const first = await cli([...common, "register", ...args], fixture);
    const second = await cli([...common, "register", ...args], fixture);
    const list = await cli([...common, "list", "--port", port], fixture);

    expect(first.code).toBe(0);
    expect(JSON.parse(second.out)).toMatchObject({ runId: JSON.parse(first.out).runId, created: false });
    expect(list.out).toMatch(new RegExp(`^${REPO}#1 `));
  });

  it("register --offline --json carries previousRunId when it replaces a failed run", async () => {
    const fixture = shepherdFixture({ frozen: true });
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const dbPath = dbFile();
    const failedRunId = await seedFailedRegistration(fixture, dbPath);
    const port = String(await deadPort());

    const result = await cli(["--db", dbPath, "shepherd", "register", `${REPO}#1`, "--task", "demo/T-1", "--implementer", "impl-a", "--offline", "--json", "--port", port], fixture);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ created: true, previousRunId: failedRunId });
    expect(JSON.parse(result.out).runId).not.toBe(failedRunId);
  });

  it("refuses a malformed ref with a usage error", async () => {
    const result = await cli(["shepherd", "merge", "not-a-ref"], shepherdFixture());

    expect(result.code).toBe(2);
    expect(result.err).toMatch(/owner\/repo#N/);
  });
});
