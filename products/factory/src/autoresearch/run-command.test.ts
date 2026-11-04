import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runCommand } from "./run-command.js";

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

  it("kills an in-flight eval's forked child when the driver gets SIGINT, then exits by the signal", async () => {
    const dir = scratch();
    const driver = forkDriver(`await runCommand(["sh", "-c", ${JSON.stringify(FORKS_SLEEPER)}, dir], { cwd: dir, graceMs: 5000 });`, dir);
    const [child] = await recordedPids(dir, 1);

    const started = Date.now();
    driver.kill("SIGINT");
    const exit = await exited(driver);

    expect(exit.signal).toBe("SIGINT");
    expect(Date.now() - started).toBeLessThan(4000);
    expect(alive(child!)).toBe(false);
  });

  it("kills an eval the driver starts during the grace, so none outlives the interrupt", async () => {
    const dir = scratch();
    const stubborn = `trap "" TERM; echo $$ >> "$0/children"; while :; do sleep 0.1; done`;
    const body = [
      `void runCommand(["sh", "-c", ${JSON.stringify(stubborn)}, dir], { cwd: dir, graceMs: 1500 });`,
      `for (;;) { console.log("spawn"); await runCommand(["sh", "-c", ${JSON.stringify(FORKS_SLEEPER)}, dir], { cwd: dir, graceMs: 100 }); await new Promise((r) => setTimeout(r, 50)); }`,
    ].join("\n");
    const driver = forkDriver(body, dir);
    const spawns = countLines(driver);
    await recordedPids(dir, 2);

    const before = spawns();
    driver.kill("SIGINT");
    const exit = await exited(driver);
    const pids = await recordedPids(dir, 2);

    expect(exit.signal).toBe("SIGINT");
    expect(spawns()).toBeGreaterThan(before);
    for (const pid of pids) expect(alive(pid)).toBe(false);
  });
});

const FORKS_SLEEPER = 'sleep 600 & echo $! >> "$0/children"; wait';
const RUN_COMMAND = new URL("./run-command.ts", import.meta.url).href;

function forkDriver(body: string, dir: string): ChildProcess {
  const code = `const { runCommand } = await import(${JSON.stringify(RUN_COMMAND)});\nconst dir = process.argv[1];\n${body}`;
  const driver = spawn(process.execPath, ["--input-type=module", "-e", code, dir], { stdio: ["ignore", "pipe", "inherit"] });
  onTestFinished(() => {
    driver.kill("SIGKILL");
    for (const pid of readPids(dir)) if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  return driver;
}

function readPids(dir: string): number[] {
  const file = join(dir, "children");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

async function recordedPids(dir: string, atLeast: number): Promise<number[]> {
  while (readPids(dir).length < atLeast) await new Promise((done) => setTimeout(done, 20));
  return readPids(dir);
}

function countLines(child: ChildProcess): () => number {
  let lines = 0;
  child.stdout!.on("data", (chunk) => (lines += String(chunk).split("\n").filter(Boolean).length));
  return () => lines;
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((done) => child.on("exit", (code, signal) => done({ code, signal })));
}
