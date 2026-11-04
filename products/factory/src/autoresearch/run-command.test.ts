import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { killLiveGroups, runCommand } from "./run-command.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const scratch = () => mkdtempSync(join(tmpdir(), "run-command-"));
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

  it("kills the forked child of an in-flight eval when the driver is signalled", async () => {
    const dir = scratch();
    const script = 'sleep 600 & echo $! > "$0/child.pid"; wait';
    const running = runCommand(["sh", "-c", script, dir], { cwd: dir, signal: never, graceMs: 100 });
    while (!existsSync(join(dir, "child.pid")) || !readFileSync(join(dir, "child.pid"), "utf8").trim()) await new Promise((done) => setTimeout(done, 20));
    const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));

    await killLiveGroups();
    await running;

    expect(alive(child)).toBe(false);
  });
});
