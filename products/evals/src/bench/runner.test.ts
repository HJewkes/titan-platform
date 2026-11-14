import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobCommand } from "./args.js";
import { TRACK_ARMS } from "./arms.js";
import type { GuardDecision } from "./guard.js";
import { transcriptPath, type LaunchResult } from "./job.js";
import { readJobRows } from "./ledger.js";
import { runBench, shuffledArms, type BenchCase, type Meter, type MeterReading, type RunOptions, type TrackPlugin } from "./runner.js";

const ARMS = TRACK_ARMS.r;
const OK: LaunchResult = { code: 0, stdout: '{"type":"result","is_error":false,"result":"done"}', stderr: "" };
const cases = (count: number): BenchCase[] => Array.from({ length: count }, (_, index) => ({ id: `case-${index}`, hash: `hash${index}`.padEnd(20, "0") }));

const plugin: TrackPlugin = {
  track: "r",
  prepare: (benchCase, arm, jobDir) => Promise.resolve({ cwd: jobDir, prompt: `${benchCase.id}|${arm.id}`, allowedTools: ["Read"], timeoutSecs: 60 }),
  score: (job) => Promise.resolve({ result: { seen: job.outcome } }),
  cleanup: () => Promise.resolve(),
};

const promptOf = (command: JobCommand): string => command.args[command.args.indexOf("-p") + 1] ?? "";
const go = (): Promise<GuardDecision> => Promise.resolve({ go: true });

/** Holds every launch until the test releases the oldest one, so completion order is first-in, first-out. */
function fifoLauncher(result: (prompt: string) => LaunchResult = () => OK) {
  const pending: (() => void)[] = [];
  const started: string[] = [];
  const finished: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const launcher = (command: JobCommand): Promise<LaunchResult> =>
    new Promise((resolve) => {
      const prompt = promptOf(command);
      started.push(prompt);
      maxInflight = Math.max(maxInflight, ++inflight);
      pending.push(() => {
        inflight--;
        finished.push(prompt);
        resolve(result(prompt));
      });
    });
  const drain = async (run: Promise<unknown>): Promise<void> => {
    const state = { done: false };
    void run.finally(() => (state.done = true));
    while (!state.done) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      pending.shift()?.();
    }
  };
  return { launcher, drain, started, finished, maxInflight: () => maxInflight };
}

describe("runBench with a fake launcher", () => {
  let outDir: string;
  beforeEach(() => void (outDir = mkdtempSync(join(tmpdir(), "bench-run-"))));
  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  const options = (overrides: Partial<RunOptions<BenchCase>>): RunOptions<BenchCase> => ({
    plugin,
    cases: cases(3),
    arms: ARMS,
    outDir,
    configDir: join(outDir, "profile"),
    operatorHome: "/srv/operator",
    jobPath: "/bin",
    seed: "test-seed",
    launcher: () => Promise.resolve(OK),
    guard: go,
    ...overrides,
  });

  it("never runs more than six jobs at once, and does reach six", async () => {
    const fake = fifoLauncher();
    const run = runBench(options({ launcher: fake.launcher }));
    await fake.drain(run);

    expect(await run).toEqual({ dispatched: 21, skipped: 0 });
    expect(fake.maxInflight()).toBe(6);
  });

  it("starts and finishes blocks in case order", async () => {
    const fake = fifoLauncher();
    const run = runBench(options({ launcher: fake.launcher }));
    await fake.drain(run);
    const blockOf = (prompt: string) => Number(prompt.slice("case-".length, prompt.indexOf("|")));

    const startedBlocks = fake.started.map(blockOf);
    expect(startedBlocks).toEqual([...startedBlocks].sort((left, right) => left - right));
    const lastFinish = [0, 1, 2].map((block) => fake.finished.map(blockOf).lastIndexOf(block));
    expect(lastFinish).toEqual([...lastFinish].sort((left, right) => left - right));
  });

  it("shuffles the arm order per block, the same way on every run", () => {
    const orders = cases(4).map((benchCase) => shuffledArms(ARMS, "test-seed", benchCase.hash).map((arm) => arm.id));

    expect(new Set(orders.map((order) => order.join())).size).toBeGreaterThan(1);
    expect(orders[0]).toEqual(shuffledArms(ARMS, "test-seed", "hash0".padEnd(20, "0")).map((arm) => arm.id));
    for (const order of orders) expect([...order].sort()).toEqual(ARMS.map((arm) => arm.id).sort());
  });

  it("on restart skips finished keys and re-runs only the infra one", async () => {
    const crashOnce = (prompt: string): LaunchResult => (prompt === "case-1|S-med" ? { code: 1, stdout: "", stderr: "killed" } : OK);
    await runBench(options({ launcher: (command) => Promise.resolve(crashOnce(promptOf(command))) }));
    const rerun: string[] = [];

    const summary = await runBench(options({ launcher: (command) => Promise.resolve(void rerun.push(promptOf(command))).then(() => OK) }));

    expect(summary).toEqual({ dispatched: 1, skipped: 20 });
    expect(rerun).toEqual(["case-1|S-med"]);
    const retried = readJobRows(join(outDir, "jobs.jsonl")).filter((row) => row.caseId === "case-1" && row.arm.id === "S-med");
    expect(retried.map((row) => [row.attempt, row.outcome])).toEqual([[1, "infra"], [2, "ok"]]);
  });

  it("runs only the first blocks under --limit-blocks", async () => {
    const summary = await runBench(options({ limitBlocks: 1 }));

    expect(summary.dispatched).toBe(ARMS.length);
    expect(new Set(readJobRows(join(outDir, "jobs.jsonl")).map((row) => row.caseId))).toEqual(new Set(["case-0"]));
  });

  it("stops dispatching on a guard stop, lets in-flight jobs finish and writes STOPPED", async () => {
    let calls = 0;
    const guard = () => Promise.resolve<GuardDecision>(++calls > 4 ? { go: false, reason: "account seven_day 93% >= 92%" } : { go: true });
    const fake = fifoLauncher();
    const run = runBench(options({ guard, launcher: fake.launcher }));
    await fake.drain(run);

    expect(await run).toEqual({ dispatched: 4, skipped: 0, stopped: "account seven_day 93% >= 92%" });
    expect(readJobRows(join(outDir, "jobs.jsonl"))).toHaveLength(4);
    expect(readFileSync(join(outDir, "STOPPED"), "utf8")).toContain("seven_day 93%");
  });

  it("records a failed prepare as infra and removes every job dir", async () => {
    const failing: TrackPlugin = { ...plugin, prepare: () => Promise.reject(new Error("no base tree")) };

    await runBench(options({ plugin: failing, cases: cases(1) }));

    expect(readJobRows(join(outDir, "jobs.jsonl")).map((row) => row.outcome)).toEqual(Array(ARMS.length).fill("infra"));
    expect(readdirOrEmpty(join(outDir, "jobs"))).toEqual([]);
  });

  it("fills tokens and cost from the meter, and a meter arm-mismatch overrides an ok launch", async () => {
    const reading = (outcome: MeterReading["outcome"]): MeterReading => ({
      tokens: { "claude-haiku-5-5": { input: 2, output: 4, cacheRead: 649, cacheWrite5m: 2308, cacheWrite1h: 0 } },
      listUsd: 0.0003,
      effortSeen: ["high"],
      modelSeen: ["claude-haiku-5-5"],
      sidechainLines: 0,
      cliMismatch: false,
      outcome,
    });
    const meter: Meter = (input) => Promise.resolve(reading(input.arm.id === "H-med" ? "arm-mismatch" : "ok"));
    const writeTranscript = (command: JobCommand): Promise<LaunchResult> => {
      const path = transcriptPath(join(outDir, "profile"), command.cwd, command.args[command.args.indexOf("--session-id") + 1] ?? "");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{}\n");
      return Promise.resolve(OK);
    };

    await runBench(options({ cases: cases(1), meter, launcher: writeTranscript }));

    const rows = readJobRows(join(outDir, "jobs.jsonl"));
    expect(rows.find((row) => row.arm.id === "H-med")?.outcome).toBe("arm-mismatch");
    expect(rows.find((row) => row.arm.id === "O-med")).toMatchObject({ outcome: "ok", listUsd: 0.0003, effortSeen: ["high"] });
  });

  it("writes the settings file and a score row per job, with null cost fields when no meter is given", async () => {
    await runBench(options({ cases: cases(1) }));

    const settings: unknown = JSON.parse(readFileSync(join(outDir, "bench-settings.json"), "utf8"));
    expect(settings).toMatchObject({ permissions: { deny: expect.arrayContaining(["Bash(gh:*)"]) as unknown } });
    const scores = readFileSync(join(outDir, "scores.jsonl"), "utf8").trim().split("\n");
    expect(scores).toHaveLength(ARMS.length);
    expect(readJobRows(join(outDir, "jobs.jsonl"))[0]).toMatchObject({ outcome: "ok", tokens: null, listUsd: null, block: 0 });
  });
});

const readdirOrEmpty = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);
