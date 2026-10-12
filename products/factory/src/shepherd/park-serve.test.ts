import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkAgent } from "@titan-design/agent-dispatch";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import { parkImplementer } from "./park.js";

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-park-serve-"));
  dirs.push(dir);
  return dir;
}

async function serve(fixture: ShepherdFixture, dir: string): Promise<FactoryServer> {
  const server = await startFactoryServer({
    dbPath: join(dir, "state", "factory.sqlite3"),
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

/**
 * A fake `agent-chat` whose `agent park` reads Shepherd back from serve before it answers, as the real one does to rule
 * out a fix round. It marks the read, then holds the park open so the test can probe serve while the child still runs.
 */
function reentrantAgentChat(dir: string, port: number): { bin: string; marker: string } {
  const marker = join(dir, "status-read");
  const child = join(dir, "child.mjs");
  writeFileSync(
    child,
    `import { writeFileSync } from "node:fs";
const res = await fetch("http://127.0.0.1:${port}/rpc/shepherd.status", {
  method: "POST",
  headers: { "content-type": "application/json", "${CLIENT_HEADER}": "agent-chat" },
  body: JSON.stringify({ repo: "${REPO}", pr: 1 }),
  signal: AbortSignal.timeout(5_000),
});
writeFileSync(${JSON.stringify(marker)}, String(res.status));
await new Promise((resolve) => setTimeout(resolve, 1_000));
console.log("Parked " + process.argv.at(-1) + ".");
`,
  );
  const bin = join(dir, "agent-chat");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${child}" "$@"\n`, { mode: 0o755 });
  return { bin, marker };
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function timedVersion(port: number): Promise<number> {
  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/version`);
  await res.text();
  expect(res.status).toBe(200);
  return performance.now() - started;
}

describe("a park whose agent-chat child reads Shepherd back from serve", () => {
  it("completes, and serve answers /version promptly while the child runs", async () => {
    const dir = scratch();
    const fixture = shepherdFixture({ frozen: true });
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const server = await serve(fixture, dir);
    const registered = await fetch(`http://127.0.0.1:${server.port}/rpc/shepherd.register`, {
      method: "POST",
      headers: { "content-type": "application/json", [CLIENT_HEADER]: "park-serve-test" },
      body: JSON.stringify({ repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" }),
    });
    const { data } = (await registered.json()) as { data: { runId: string } };
    const { bin, marker } = reentrantAgentChat(dir, server.port);

    const parking = parkImplementer(fixture.routes.shepherd!.store, (name) => parkAgent(bin, name, 10_000), { runId: data.runId, headSha: H1 });
    await until(() => existsSync(marker));
    const versionMs = await timedVersion(server.port);
    const outcome = await parking;

    expect(outcome).toMatchObject({ kind: "parked", lines: expect.arrayContaining(["Parked impl-a."]) });
    expect(versionMs).toBeLessThan(100);
  }, 20_000);
});
