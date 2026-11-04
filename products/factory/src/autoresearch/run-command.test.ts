import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORKS_SLEEPER, PROCESS_TEST_MS, alive, dead, exited, forkDriver, readPids, recordedPids, scratch } from "./eval-driver.test-helpers.js";
import { runCommand, stopEvals } from "./run-command.js";

const never = new AbortController().signal;

describe("runCommand", () => {
  it("kills a forked child of a timed-out script", async () => {
    const dir = scratch();
    const script = 'sleep 600 & echo $! > "$0/child.pid"; wait';
    const run = await runCommand(["sh", "-c", script, dir], { cwd: dir, signal: never, timeoutMs: 300, graceMs: 100 });

    expect(run.ok).toBe(false);
    const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    await new Promise((done) => setTimeout(done, 50));
    expect(alive(child)).toBe(false);
  });

  it("escalates to SIGKILL for a child that ignores SIGTERM", async () => {
    const dir = scratch();
    const script = `sh -c 'trap "" TERM; echo $$ > "$0/stubborn.pid"; while :; do sleep 1; done' "$0" & wait`;
    await runCommand(["sh", "-c", script, dir], { cwd: dir, signal: never, timeoutMs: 400, graceMs: 200 });

    const pid = Number(readFileSync(join(dir, "stubborn.pid"), "utf8"));
    await new Promise((done) => setTimeout(done, 100));
    expect(alive(pid)).toBe(false);
  });

  it("does not count time before the work-started marker against the timeout", async () => {
    const dir = scratch();
    const script = "sleep 0.6; echo ar-work-started >&2; sleep 0.2; echo done";
    const run = await runCommand(["sh", "-c", script], { cwd: dir, signal: never, timeoutMs: 500, waitAllowanceMs: 2_000 });

    expect(run.ok).toBe(true);
    expect(run.waitedMs).toBeGreaterThanOrEqual(500);
  });

  it("kills a runner that never prints the marker once timeout plus allowance passes", async () => {
    const dir = scratch();
    const run = await runCommand(["sh", "-c", "exec sleep 600"], { cwd: dir, signal: never, timeoutMs: 100, waitAllowanceMs: 100, graceMs: 100 });

    expect(run.ok).toBe(false);
  });

  it("still times out work that starts and then hangs", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "hang.sh"), "echo ar-work-started >&2\nexec sleep 600\n");
    const run = await runCommand(["sh", join(dir, "hang.sh")], { cwd: dir, signal: never, timeoutMs: 300, graceMs: 100 });

    expect(run.ok).toBe(false);
  });

  it("stopping evals kills an in-flight eval's forked child and resolves once it is down, without sitting out the grace", async () => {
    const dir = scratch();
    const running = runCommand(["sh", "-c", FORKS_SLEEPER, dir], { cwd: dir, graceMs: 600_000 });
    const [child] = await recordedPids(dir, 1);

    await stopEvals();

    expect((await running).ok).toBe(false);
    expect(await dead([child!])).toBe(true);
  }, PROCESS_TEST_MS);

  it("kills an eval started while evals are stopping, so none outlives the stop", async () => {
    const dir = scratch();
    const stubborn = runCommand(["sh", "-c", `trap "" TERM; echo $$ >> "$0/children"; while :; do sleep 0.1; done`, dir], { cwd: dir, graceMs: 1_000 });
    const [holdout] = await recordedPids(dir, 1);
    const stopped = stopEvals();

    const late = await runCommand(["sh", "-c", FORKS_SLEEPER, dir], { cwd: dir, graceMs: 600_000 });
    await stopped;
    await stubborn;

    expect(late.ok).toBe(false);
    expect(await dead([holdout!, ...readPids(dir)])).toBe(true);
  }, PROCESS_TEST_MS);

  it("runs evals normally again once a stop has finished", async () => {
    await stopEvals();

    const run = await runCommand(["sh", "-c", "echo fine"], { cwd: scratch() });

    expect(run).toMatchObject({ ok: true, stdout: "fine\n" });
  });

  it("leaves the exit to a host that owns its shutdown, so its own cleanup finishes", async () => {
    const dir = scratch();
    const body = [
      `process.once("SIGTERM", async () => { await stopEvals(); await new Promise((r) => setTimeout(r, 200)); writeFileSync(dir + "/cleaned", ""); process.exit(0); });`,
      `void runCommand(["sh", "-c", ${JSON.stringify(FORKS_SLEEPER)}, dir], { cwd: dir, graceMs: 600_000 });`,
    ].join("\n");
    const driver = forkDriver({ "runCommand, stopEvals": RUN_COMMAND, writeFileSync: "node:fs" }, body, dir);
    const [child] = await recordedPids(dir, 1);

    driver.kill("SIGTERM");
    const exit = await exited(driver);

    expect(exit).toEqual({ code: 0, signal: null });
    expect(existsSync(join(dir, "cleaned"))).toBe(true);
    expect(await dead([child!])).toBe(true);
  }, PROCESS_TEST_MS);
});

const RUN_COMMAND = new URL("./run-command.ts", import.meta.url).href;
