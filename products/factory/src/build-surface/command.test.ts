import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../cli.js";
import { DEMO_REPO, demoSpec, fakeBuild, stubbedRoutes } from "../test-support/build-surface.js";
import { buildSurfaceWorkflow } from "./workflow.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "build-surface-cli-"));
  dirs.push(dir);
  return dir;
}

/** Port 1 never answers, so every verb takes its in-process path against the scratch database. */
const NO_SERVE = ["--port", "1"];

async function cli(argv: string[], db: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { stdout: (text) => void (out += text), stderr: (text) => void (err += text), env };
  const fake = fakeBuild();
  const deps = { workflows: [buildSurfaceWorkflow()], routes: stubbedRoutes(fake), host: { gatePollMs: 5 }, serveWaitMs: 50, presence: async () => undefined };
  const code = await runCli(["--db", db, ...argv], io, deps);
  return { code, out, err };
}

function specFile(text = demoSpec()): string {
  const path = join(tempDir(), "BUILD-SPEC.md");
  writeFileSync(path, text);
  return path;
}

describe("titan-factory build-surface", () => {
  it("starts a run here when no serve answers, runs it to its first owner gate and prints how to resolve it", async () => {
    const db = join(tempDir(), "factory.sqlite3");

    const { code, out } = await cli(["build-surface", "start", DEMO_REPO, "--spec", specFile(), ...NO_SERVE], db);

    expect(code).toBe(0);
    expect(out).toMatch(/run (\S+) build-surface owner\/demo-repo: paused/);
    expect(out).toMatch(/titan-factory gate resolve \S+ deploy-approve:shell --json/);
  });

  it("returns the unfinished run on a second start instead of starting a rival, and status lists it", async () => {
    const db = join(tempDir(), "factory.sqlite3");
    const spec = specFile();
    const first = await cli(["build-surface", "start", DEMO_REPO, "--spec", spec, ...NO_SERVE], db);
    const runId = /run (\S+) build-surface/.exec(first.out)![1]!;

    const second = await cli(["build-surface", "start", DEMO_REPO, "--spec", spec, ...NO_SERVE], db);
    const status = await cli(["build-surface", "status", DEMO_REPO, ...NO_SERVE], db);

    expect(second.out).toContain(`run ${runId} build-surface owner/demo-repo: paused`);
    expect(status.out.trim().split("\n")).toEqual([expect.stringMatching(new RegExp(`^run ${runId} build-surface owner/demo-repo: paused`))]);
  });

  it("refuses a spec written for another repo as a usage error, starting nothing", async () => {
    const db = join(tempDir(), "factory.sqlite3");

    const { code, err } = await cli(["build-surface", "start", DEMO_REPO, "--spec", specFile(demoSpec({ repo: "owner/other-repo" })), ...NO_SERVE], db);
    const status = await cli(["build-surface", "status", DEMO_REPO, ...NO_SERVE], db);

    expect(code).toBe(2);
    expect(err).toMatch(/build spec is for owner\/other-repo/);
    expect(status.out).toBe("no build-surface run for owner/demo-repo\n");
  });

  it("refuses to run in-process from an agent's env when no serve answers", async () => {
    const db = join(tempDir(), "factory.sqlite3");

    const { code, err } = await cli(["build-surface", "start", DEMO_REPO, "--spec", specFile(), ...NO_SERVE], db, { AGENT_CHAT_AGENT_ID: "agent-1" });

    expect(code).toBe(69);
    expect(err).toMatch(/build-surface start would write in-process/);
  });
});
