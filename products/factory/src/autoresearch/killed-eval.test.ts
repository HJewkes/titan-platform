import { describe, expect, it } from "vitest";
import { baselineRun } from "./baseline-run.test-helpers.js";
import { PROCESS_TEST_MS, scratch } from "./eval-driver.test-helpers.js";

/** Stands in for the kernel's OOM killer: the runner logs, then dies by a signal nobody in the driver sent. */
const KILLED_FROM_OUTSIDE = 'echo "runner started" >&2; kill -KILL $$';

describe("an autoresearch run whose eval child is killed from outside", () => {
  it("settles instead of hanging, with the signal in the run's error", async () => {
    const { host, runId } = baselineRun(scratch(), () => KILLED_FROM_OUTSIDE);

    await host.runtime.wait(runId);

    const run = host.runtime.status(runId)!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("killed by SIGKILL");
  }, PROCESS_TEST_MS);
});
