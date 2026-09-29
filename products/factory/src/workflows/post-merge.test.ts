import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import type { PostMergeConfig } from "../config.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { StepRoute } from "../routed-runner.js";
import { crashAt } from "../test-support/crash.js";
import { H1, REPO, answerPendingGate, gateId, gateOpened } from "../test-support/land.js";
import { landPrRoutes, landPrWorkflow } from "./land-pr.js";
import { NO_COMMAND, TAIL_CHARS, execChore, type ChoreExec, type ChoreOptions } from "./post-merge.js";

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface Chore {
  calls: { argv: readonly string[]; options: ChoreOptions }[];
  exec: ChoreExec;
}

function fakeChore(result: Partial<Awaited<ReturnType<ChoreExec>>> = {}): Chore {
  const calls: Chore["calls"] = [];
  const exec: ChoreExec = async (argv, options) => {
    calls.push({ argv, options });
    return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", ...result };
  };
  return { calls, exec };
}

/** One PR at H1 with green required checks, and the land-pr routes with `postMerge` configured as given. */
function world(postMerge: PostMergeConfig | undefined, chore: Chore): { fake: FakeGitHub; routes: StepRoute[] } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  const routes = landPrRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms), postMerge, runChore: chore.exec });
  return { fake, routes };
}

async function landToEnd(postMerge: PostMergeConfig | undefined, chore: Chore): Promise<{ host: FactoryHost; runId: string; fake: FakeGitHub }> {
  const { fake, routes } = world(postMerge, chore);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("land-pr", { repo: REPO, pr: "1" });
  await gateOpened(host, gateId(runId, "approve-merge"));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });
  await host.runtime.wait(runId);
  return { host, runId, fake };
}

function postMergeRecord(host: FactoryHost, runId: string): unknown {
  return Object.values(host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "post-merge")?.data;
}

/** A kill after the chore ran but before the run recorded the step. */
function hangAfterChore(routes: readonly StepRoute[], entered: () => void): StepRoute[] {
  return routes.map((route) => ({
    ...route,
    runner: {
      run: async (input) => {
        const outcome = await route.runner.run(input);
        if (input.stepId !== "post-merge") return outcome;
        entered();
        return new Promise(() => undefined);
      },
    },
  }));
}

describe("post-merge step", () => {
  it("records skipped and runs nothing when no post-merge command is configured", async () => {
    const chore = fakeChore();

    const { host, runId, fake } = await landToEnd(undefined, chore);

    expect(host.runtime.status(runId)?.status).toBe("completed");
    expect(fake.effects.merge).toBe(1);
    expect(chore.calls).toEqual([]);
    expect(postMergeRecord(host, runId)).toMatchObject({ result: { skipped: NO_COMMAND } });
  });

  it("runs the configured argv once after the merge with the PR in its environment", async () => {
    const chore = fakeChore();

    const { host, runId, fake } = await landToEnd({ argv: ["chore", "--prune"], cwd: "/work", timeoutMs: 5_000 }, chore);

    expect(chore.calls).toHaveLength(1);
    expect(chore.calls[0]!.argv).toEqual(["chore", "--prune"]);
    expect(chore.calls[0]!.options).toMatchObject({ cwd: "/work", timeoutMs: 5_000 });
    expect(chore.calls[0]!.options.env).toMatchObject({ LAND_PR_REPO: REPO, LAND_PR_NUMBER: "1", LAND_PR_MERGE_SHA: fake.pr(1).mergeSha });
    expect(postMergeRecord(host, runId)).toMatchObject({ result: { exitCode: 0, signal: null, timedOut: false, stdoutTail: "", stderrTail: "" } });
  });

  it("records a failing chore with redacted tails and still completes the run", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    const chore = fakeChore({ exitCode: 3, stdout: `${"x".repeat(TAIL_CHARS)}done`, stderr: `push failed: ${token}` });

    const { host, runId } = await landToEnd({ argv: ["chore"] }, chore);
    const record = postMergeRecord(host, runId) as { result: { exitCode: number; stdoutTail: string; stderrTail: string } };

    expect(host.runtime.status(runId)?.status).toBe("completed");
    expect(record.result.exitCode).toBe(3);
    expect(record.result.stdoutTail).toHaveLength(TAIL_CHARS);
    expect(record.result.stdoutTail.endsWith("done")).toBe(true);
    expect(record.result.stderrTail).toBe("push failed: [redacted]");
  });

  it("redacts a token that straddles the tail cut instead of keeping its unmatched suffix", async () => {
    const chore = fakeChore({ stdout: `ghp_${"Q".repeat(36)}${"y".repeat(TAIL_CHARS - 20)}` });

    const { host, runId } = await landToEnd({ argv: ["chore"] }, chore);
    const record = postMergeRecord(host, runId) as { result: { stdoutTail: string } };

    expect(record.result.stdoutTail).not.toContain("Q");
    expect(record.result.stdoutTail.startsWith("[redacted]")).toBe(true);
  });

  it("records a timed-out chore as timed out and still completes the run as merged", async () => {
    const chore = fakeChore({ exitCode: null, signal: "SIGKILL", timedOut: true });

    const { host, runId, fake } = await landToEnd({ argv: ["chore"], timeoutMs: 100 }, chore);

    expect(host.runtime.status(runId)?.status).toBe("completed");
    expect(fake.effects.merge).toBe(1);
    expect(postMergeRecord(host, runId)).toMatchObject({ result: { exitCode: null, signal: "SIGKILL", timedOut: true } });
  });

  it("parks the run as recovery_required after a crash mid-chore and never runs the chore again", async () => {
    const chore = fakeChore();
    const { fake, routes } = world({ argv: ["chore"] }, chore);
    const dir = mkdtempSync(join(tmpdir(), "factory-post-merge-"));
    dirs.push(dir);
    let entered!: () => void;
    const hung = new Promise<void>((resolve) => (entered = resolve));
    const crash = crashAt({ dbPath: join(dir, "factory.sqlite3"), workflows: [landPrWorkflow()], routes: hangAfterChore(routes, entered), hangAt: "never" });
    const runId = crash.crashed.runtime.start("land-pr", { repo: REPO, pr: "1" });
    await approveUntil(crash.crashed, runId, fake, hung);

    const report = await crash.takeOver(routes).resume();
    crash.dispose();

    expect(report.held).toMatchObject([{ reason: "recovery_required", run: { id: runId, status: "recovery_required" } }]);
    expect(chore.calls).toHaveLength(1);
    expect(fake.effects.merge).toBe(1);
  });
});

async function approveUntil(host: FactoryHost, runId: string, fake: FakeGitHub, hung: Promise<void>): Promise<void> {
  let stopped = false;
  void hung.then(() => (stopped = true));
  while (!stopped) {
    answerPendingGate(host, runId, fake);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("execChore", () => {
  const options = (extra: Partial<ChoreOptions> = {}): ChoreOptions => ({ timeoutMs: 10_000, env: { ...process.env, CHORE_VAR: "from-env" }, ...extra });

  it("passes each argv entry to the program verbatim, with no shell to split or expand it", async () => {
    const script = "process.stdout.write(JSON.stringify([process.argv[1], process.env.CHORE_VAR]))";

    const result = await execChore([process.execPath, "-e", script, "a; echo injected $CHORE_VAR"], options());

    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(["a; echo injected $CHORE_VAR", "from-env"]);
  });

  it("resolves a non-zero exit with its code instead of rejecting", async () => {
    const result = await execChore([process.execPath, "-e", "process.stderr.write('nope'); process.exit(4)"], options());

    expect(result).toMatchObject({ exitCode: 4, signal: null, stderr: "nope" });
    expect(result.error).toBeUndefined();
  });

  it("resolves a missing program with the spawn error", async () => {
    const result = await execChore(["titan-factory-no-such-program"], options());

    expect(result).toMatchObject({ exitCode: null, signal: null, error: expect.stringContaining("ENOENT") });
  });

  it("kills a chore that outlives its timeout and records it as timed out", async () => {
    const result = await execChore([process.execPath, "-e", "setTimeout(() => {}, 10_000)"], options({ timeoutMs: 100 }));

    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: true });
  });

  it("kills a chore that traps SIGTERM once its timeout passes", async () => {
    const started = Date.now();

    const result = await execChore([process.execPath, "-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 3_000)"], options({ timeoutMs: 200 }));

    expect(result).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("kills a timed-out chore's background children, which would otherwise hold its output open", async () => {
    const started = Date.now();

    const result = await execChore(["/bin/sh", "-c", "sleep 3 & wait"], options({ timeoutMs: 200 }));

    expect(result).toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
