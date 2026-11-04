import { describe, expect, it } from "vitest";
import { FORKS_SLEEPER, PROCESS_TEST_MS, dead, exited, forkDriver, recordedPids, scratch } from "./eval-driver.test-helpers.js";

const EVAL_SIGNALS = new URL("./eval-signals.ts", import.meta.url).href;
const RUN_COMMAND = new URL("./run-command.ts", import.meta.url).href;
const imports = { stoppingEvalsOnSignal: EVAL_SIGNALS, runCommand: RUN_COMMAND };

describe("a CLI driving evals in its own process", () => {
  it("kills the in-flight eval's forked child on SIGINT, then exits by the signal without sitting out the grace", async () => {
    const dir = scratch();
    const body = `await stoppingEvalsOnSignal(() => runCommand(["sh", "-c", ${JSON.stringify(FORKS_SLEEPER)}, dir], { cwd: dir, graceMs: 600_000 }));`;
    const driver = forkDriver(imports, body, dir);
    const [child] = await recordedPids(dir, 1);

    driver.kill("SIGINT");
    const exit = await exited(driver);

    expect(exit.signal).toBe("SIGINT");
    expect(await dead([child!])).toBe(true);
  }, PROCESS_TEST_MS);

  it("kills evals the driver keeps starting after SIGTERM, then exits by the signal", async () => {
    const dir = scratch();
    const stubborn = `trap "" TERM; echo $$ >> "$0/children"; while :; do sleep 0.1; done`;
    const body = [
      `void runCommand(["sh", "-c", ${JSON.stringify(stubborn)}, dir], { cwd: dir, graceMs: 1_000 });`,
      `await stoppingEvalsOnSignal(async () => { for (;;) { await runCommand(["sh", "-c", ${JSON.stringify(FORKS_SLEEPER)}, dir], { cwd: dir, graceMs: 100 }); await new Promise((r) => setTimeout(r, 50)); } });`,
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
