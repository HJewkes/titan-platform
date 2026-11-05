import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkAgent } from "@titan-design/agent-dispatch";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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
function reentrantAgentChat(dir: string, port: number): { bin: string; marker: string; release: string } {
  const marker = join(dir, "status-read");
  const release = join(dir, "release");
  const child = join(dir, "child.mjs");
  writeFileSync(
    child,
    `import { existsSync, writeFileSync } from "node:fs";
const res = await fetch("http://127.0.0.1:${port}/rpc/shepherd.status", {
  method: "POST",
  headers: { "content-type": "application/json", "${CLIENT_HEADER}": "agent-chat" },
  body: JSON.stringify({ repo: "${REPO}", pr: 1 }),
  signal: AbortSignal.timeout(5_000),
}).catch(() => ({ status: 0 }));
writeFileSync(${JSON.stringify(marker)}, String(res.status));
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 20));
console.log("Parked " + process.argv.at(-1) + ".");
`,
  );
  const bin = join(dir, "agent-chat");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${child}" "$@"\n`, { mode: 0o755 });
  return { bin, marker, release };
}

const Registered = z.object({ data: z.object({ runId: z.string() }) });

async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("a park whose agent-chat child reads Shepherd back from serve", () => {
  // A park that blocked serve's event loop would answer /version only after the child had exited and the park settled.
  it("completes, and serve answers /version while the child still runs", async () => {
    const dir = scratch();
    const fixture = shepherdFixture({ frozen: true });
    fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
    const server = await serve(fixture, dir);
    const registered = await fetch(`http://127.0.0.1:${server.port}/rpc/shepherd.register`, {
      method: "POST",
      headers: { "content-type": "application/json", [CLIENT_HEADER]: "park-serve-test" },
      body: JSON.stringify({ repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" }),
    });
    const body: unknown = await registered.json();
    const { data } = Registered.parse(body);
    const { bin, marker, release } = reentrantAgentChat(dir, server.port);
    let settled = false;

    const parking = parkImplementer(fixture.routes.shepherd!.store, (name) => parkAgent(bin, name, 10_000), { runId: data.runId, headSha: H1 }).finally(() => (settled = true));
    await until(() => existsSync(marker));
    const version = await fetch(`http://127.0.0.1:${server.port}/version`);
    const settledAtVersion = settled;
    writeFileSync(release, "");
    const outcome = await parking;

    expect(version.status).toBe(200);
    expect(settledAtVersion).toBe(false);
    expect(outcome).toMatchObject({ kind: "parked", lines: expect.arrayContaining(["Parked impl-a."]) });
  });
});
