import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import type { GitHubWire } from "@titan-design/github";
import { githubPort } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, runCli, type CliDeps } from "./cli.js";
import { H1, REPO } from "./test-support/land.js";
import { BRANCH, shepherdFixture } from "./test-support/shepherd.js";

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

/** A fake GitHub behind a wire that records every call, so a refusal can assert none was made. */
function countingSetup(): { deps: CliDeps; dbPath: string; calls: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "factory-agent-env-"));
  dirs.push(dir);
  const calls: string[] = [];
  const fixture = shepherdFixture();
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const wire = new Proxy(fixture.fake.wire, {
    get: (target, key) => {
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? (...args: unknown[]) => (calls.push(String(key)), (value as (...a: unknown[]) => unknown).apply(target, args)) : value;
    },
  }) as GitHubWire;
  const counted = shepherdFixture({ port: githubPort(wire) });
  return { deps: { workflows: counted.workflows, routes: counted.routes, host: { gatePollMs: 5 }, logger: silentLogger, serveWaitMs: 50 }, dbPath: join(dir, "state", "factory.sqlite3"), calls };
}

async function cli(argv: string[], deps: CliDeps, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env }, deps);
  return { code, out, err };
}

const AGENT = { AGENT_CHAT_NAME: "demo-impl", AGENT_CHAT_AGENT_ID: "id-1" };
const SHA = "a".repeat(40);

describe("write verbs in an agent env with no serve answering", () => {
  const writes: Array<[string, (port: string) => string[]]> = [
    ["land", (port) => ["land", `${REPO}#1`, "--port", port]],
    ["shepherd merge", (port) => ["shepherd", "merge", `${REPO}#1`, "--port", port]],
    ["shepherd review", (port) => ["shepherd", "review", `${REPO}#1`, "--port", port]],
    ["shepherd release", (port) => ["shepherd", "release", `${REPO}#1`, "--head", SHA, "--port", port]],
    ["shepherd hold", (port) => ["shepherd", "hold", `${REPO}#1`, "--reason", "demo", "--port", port]],
    ["shepherd resync", (port) => ["shepherd", "resync", "--port", port]],
    ["shepherd repair-go", (port) => ["shepherd", "repair-go", `${REPO}#1`, "--port", port]],
    ["shepherd repair-stop", (port) => ["shepherd", "repair-stop", `${REPO}#1`, "--reason", "demo", "--port", port]],
    ["resume", (port) => ["resume", "--port", port]],
    ["gate resolve", (port) => ["gate", "resolve", "run-1", "step-1", "--json", "{}", "--port", port]],
  ];

  it.each(writes)("%s exits UNAVAILABLE and makes no GitHub call", async (verb, argvOf) => {
    const { deps, dbPath, calls } = countingSetup();

    const result = await cli(["--db", dbPath, ...argvOf(String(await deadPort()))], deps, AGENT);

    expect(result.code).toBe(EXIT.UNAVAILABLE);
    expect(result.err).toContain("connection refused, so serve is down");
    expect(result.err).toContain("would write in-process, which an agent env refuses");
    expect(calls).toEqual([]);
  });

  it("repair-stops, a read, still falls back to the database here", async () => {
    const { deps, dbPath } = countingSetup();

    const result = await cli(["--db", dbPath, "shepherd", "repair-stops", "--port", String(await deadPort())], deps, AGENT);

    expect(result.code).toBe(EXIT.OK);
  });

  it("status, a read, still falls back to the database here", async () => {
    const { deps, dbPath } = countingSetup();

    const result = await cli(["--db", dbPath, "shepherd", "status", "--port", String(await deadPort())], deps, AGENT);

    expect(result.code).toBe(EXIT.OK);
  });

  it("without the agent env, land still runs in-process", async () => {
    const { deps, dbPath } = countingSetup();

    const result = await cli(["--db", dbPath, "land", `${REPO}#1`, "--port", String(await deadPort())], deps, { AGENT_CHAT_NAME: "demo-impl" });

    expect(result.out).toContain("so this ran in-process");
    expect(result.code).not.toBe(EXIT.UNAVAILABLE);
  });
});
