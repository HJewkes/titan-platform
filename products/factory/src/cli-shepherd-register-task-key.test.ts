import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT, runCli } from "./cli.js";
import type { CliDeps } from "./cli-types.js";
import { portOf } from "./test-support/fakes.js";
import { H1, REPO } from "./test-support/land.js";
import { BRANCH, shepherdFixture } from "./test-support/shepherd.js";
import { olderDaemonFetch, taskIndexFetch } from "./test-support/task-index.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const dbFile = (): string => join(tempDir("factory-register-"), "state", "factory.sqlite3");

async function cli(argv: string[], deps: CliDeps, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env }, deps);
  return { code, out, err };
}

async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = portOf(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const registerDeps = (fetch: typeof globalThis.fetch): CliDeps => {
  const fixture = shepherdFixture({ frozen: true, prFiles: async () => [] });
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  return { workflows: fixture.workflows, routes: fixture.routes, host: { gatePollMs: 5 }, logger: silentLogger, fetch };
};

const runParams = (dbPath: string, runId: string): Record<string, string> => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = z.object({ params: z.string() }).parse(db.prepare("select params from workflow_run where id = ?").get(runId));
    return z.record(z.string(), z.string()).parse(JSON.parse(row.params));
  } finally {
    db.close();
  }
};

/** An empty active-work root, so an older daemon's archives list as none rather than unreadable. */
const activeRootEnv = (): NodeJS.ProcessEnv => {
  return { ACTIVE_ROOT: tempDir("factory-aw-root-") };
};

describe("shepherd register task keys", () => {
  it("refuses with 65 a bare ID no initiative has, naming the expected form", async () => {
    const result = await cli(["--db", dbFile(), "shepherd", "register", `${REPO}#1`, "--task", "CC-784", "--implementer", "agent", "--offline", "--port", String(await deadPort())], registerDeps(taskIndexFetch([])));
    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.err).toContain("pass --task <initiative>/<ID>");
  });

  it("refuses with 65 a key whose prefix is not the task's initiative", async () => {
    const result = await cli(["--db", dbFile(), "shepherd", "register", `${REPO}#1`, "--task", "agent-chat/T-1", "--implementer", "impl-a", "--offline", "--port", String(await deadPort())], registerDeps(taskIndexFetch()));
    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.err).toContain("task T-1 is in demo, not agent-chat");
  });

  it("falls back to task.list on a daemon older than task.keys, stores the canonical key and does not exit 69", async () => {
    const dbPath = dbFile();
    const result = await cli(["--db", dbPath, "shepherd", "register", `${REPO}#1`, "--task", "T-1", "--implementer", "impl-a", "--offline", "--json", "--port", String(await deadPort())], registerDeps(olderDaemonFetch()), activeRootEnv());

    expect(result.code).toBe(EXIT.OK);
    expect(result.err).not.toContain("warning");
    const { runId, registration } = JSON.parse(result.out);
    expect(registration.task).toBe("demo/T-1");
    expect(runParams(dbPath, runId).taskVerified).toBeUndefined();
  });

  it("still refuses with 65 a key an older daemon's index has no task for", async () => {
    const result = await cli(["--db", dbFile(), "shepherd", "register", `${REPO}#1`, "--task", "demo/T-9", "--implementer", "impl-a", "--offline", "--port", String(await deadPort())], registerDeps(olderDaemonFetch()), activeRootEnv());

    expect(result.code).toBe(EXIT.REFUSED);
    expect(result.err).toContain("refused (not-found)");
  });

  it("stores the key as given, marked taskVerified=false with a warning, when no task index answers", async () => {
    const dbPath = dbFile();
    const down = (async () => Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;

    const result = await cli(["--db", dbPath, "shepherd", "register", `${REPO}#1`, "--task", "demo/T-1", "--implementer", "impl-a", "--offline", "--json", "--port", String(await deadPort())], registerDeps(down));

    expect(result.code).toBe(EXIT.OK);
    expect(result.err).toContain('warning: task key "demo/T-1" stored as given, not verified');
    const { runId, registration } = JSON.parse(result.out);
    expect(registration.task).toBe("demo/T-1");
    expect(runParams(dbPath, runId).taskVerified).toBe("false");
  });
});
