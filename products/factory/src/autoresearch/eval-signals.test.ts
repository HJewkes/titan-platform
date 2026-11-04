import { arStepId, BoundsSchema, TargetSchema, type ArPorts } from "@titan-design/autoresearch";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openFactoryHost } from "../host.js";
import { FORKS_SLEEPER, PROCESS_TEST_MS, dead, exited, forkDriver, readPids, recordedPids, scratch } from "./eval-driver.test-helpers.js";
import { shuttingDownOnSignal } from "./eval-signals.js";
import { lastLine, runCommand } from "./run-command.js";
import { arRoutes } from "./routes.js";
import { autoresearchWorkflow } from "./workflow.js";

const EVAL_SIGNALS = new URL("./eval-signals.ts", import.meta.url).href;
const RUN_COMMAND = new URL("./run-command.ts", import.meta.url).href;
const imports = { shuttingDownOnSignal: EVAL_SIGNALS, runCommand: RUN_COMMAND };
const IDLE_RUNTIME = "{ quiesce() {}, shutdown() {} }";
const IGNORES_TERM = `trap "" TERM; echo $$ >> "$0/children"; while :; do sleep 0.1; done`;

describe("a CLI driving evals in its own process", () => {
  it("kills the in-flight eval's forked child on SIGINT, then exits by the signal without sitting out the grace", async () => {
    const dir = scratch();
    const body = `await shuttingDownOnSignal(${IDLE_RUNTIME}, () => runCommand(["sh", "-c", ${JSON.stringify(FORKS_SLEEPER)}, dir], { cwd: dir, graceMs: 600_000 }));`;
    const driver = forkDriver(imports, body, dir);
    const [child] = await recordedPids(dir, 1);

    driver.kill("SIGINT");
    const exit = await exited(driver);

    expect(exit.signal).toBe("SIGINT");
    expect(await dead([child!])).toBe(true);
  }, PROCESS_TEST_MS);

  it("kills evals the driver keeps starting after SIGTERM, then exits by the signal", async () => {
    const dir = scratch();
    const body = [
      `void runCommand(["sh", "-c", ${JSON.stringify(IGNORES_TERM)}, dir], { cwd: dir, graceMs: 1_000 });`,
      `await shuttingDownOnSignal(${IDLE_RUNTIME}, async () => { for (;;) { await runCommand(["sh", "-c", ${JSON.stringify(FORKS_SLEEPER)}, dir], { cwd: dir, graceMs: 100 }); await new Promise((r) => setTimeout(r, 50)); } });`,
    ].join("\n");
    const driver = forkDriver(imports, body, dir);
    await recordedPids(dir, 2);

    driver.kill("SIGTERM");
    const exit = await exited(driver);
    const pids = await recordedPids(dir, 2);

    expect(exit.signal).toBe("SIGTERM");
    expect(await dead(pids)).toBe(true);
  }, PROCESS_TEST_MS);
});

/** Two baseline evals at once, as the recipe runs them: `b1` ignores TERM and sits out its grace, `b2` dies at TERM. */
function baselinePorts(dir: string): ArPorts {
  const unused = () => Promise.reject(new Error("not reached"));
  const metric = { primary: { name: "score", direction: "min" }, noise: {} };
  const target = TargetSchema.parse({ schema: "ar-target/v1", ratchetPrefix: "autoresearch/fixture", metric, phases: [{ id: "p1", train: ["t-1"], baselineRuns: 2, stop: { ideasEvaluated: 1, roundsWithoutGain: 1 } }] });
  const bounds = BoundsSchema.parse({ schema: "ar-bounds/v1", classes: {} });
  const evalCase: ArPorts["evalCase"] = async (input, signal) => {
    const argv = ["sh", "-c", input.key.endsWith("-b1") ? IGNORES_TERM : FORKS_SLEEPER, dir];
    return lastLine(await runCommand(argv, { cwd: dir, signal, graceMs: 1_000 }), argv) as never;
  };
  return {
    pin: async ({ pin }) => ({ pin, ratchetRef: "refs/heads/autoresearch/fixture/run", ratchetHead: pin, integrationTree: dir, target, bounds }),
    plan: unused, allocTree: unused, implement: unused, staticCheck: unused, micro: unused, ratchet: unused, releaseTree: unused,
    evalCase,
    now: Date.now,
  };
}

/** The CLI's re-raise, caught here so it does not take the test worker down; every other kill goes through. */
function catchReRaise(): Promise<string | number | undefined> {
  const real = process.kill.bind(process);
  return new Promise((raised) => {
    const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => (pid === process.pid ? (raised(signal), true) : real(pid, signal)));
    onTestFinished(() => spy.mockRestore());
  });
}

describe("a CLI interrupted while two evals run", () => {
  it("leaves the run resumable and records no eval the shutdown killed, though one eval ignores TERM", async () => {
    const dir = scratch();
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [autoresearchWorkflow()], routes: arRoutes(() => baselinePorts(dir)), gatePollMs: 5 });
    onTestFinished(() => host.close());
    const reRaised = catchReRaise();
    const runId = host.runtime.start("autoresearch", { pin: "a".repeat(40) });
    const driven = shuttingDownOnSignal(host.runtime, () => host.runtime.wait(runId));
    const onSignal = process.listeners("SIGTERM").at(-1)!;
    await recordedPids(dir, 2);

    onSignal("SIGTERM");
    await driven;

    const run = host.runtime.status(runId)!;
    expect(await reRaised).toBe("SIGTERM");
    expect(run.status).toBe("running");
    expect(Object.keys(run.stepResults).filter((key) => key.startsWith(arStepId("eval")))).toEqual([]);
    expect(await dead(readPids(dir))).toBe(true);
  }, PROCESS_TEST_MS);
});
