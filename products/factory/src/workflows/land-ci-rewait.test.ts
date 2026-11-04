import { FakeHttpError, successRun, type CheckRun } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId, gateOpened, landScenario, outsideActions, type LandScenario } from "../test-support/land.js";
import { CI_WAIT_ATTEMPTS } from "./land.js";

const MIN = 60_000;
const TIMEOUT_MS = 45 * MIN;
const GREEN: CheckRun[] = [successRun("validate", 1), successRun("dag-check", 2)];

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function start(scenario: LandScenario): { host: FactoryHost; runId: string } {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [scenario.workflow], routes: scenario.routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, runId: host.runtime.start("land-test") };
}

/** mergeable_state reads unknown until `settlesAtMs` on the fake clock, with `runs` until then and green after. */
function unsettledUntil(settlesAtMs: number, runs: CheckRun[] = GREEN, after: CheckRun[] = GREEN): LandScenario {
  const scenario = landScenario({ ciTimeoutMs: TIMEOUT_MS });
  scenario.fake.onGetPr = (pr) => {
    const settled = scenario.now() >= settlesAtMs;
    pr.mergeableState = settled ? "clean" : "unknown";
    scenario.fake.setRuns(pr.headSha, settled ? after : runs);
  };
  return scenario;
}

function ciWaitSteps(host: FactoryHost, runId: string): string[] {
  return Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId).filter((id) => id.startsWith("ci-wait"));
}

describe("land when a ci-wait window runs out on a wait only GitHub ends", () => {
  it("waits again in a fresh ci-wait and reaches the merge decision once mergeable_state settles", async () => {
    const scenario = unsettledUntil(50 * MIN);
    const { host, runId } = start(scenario);

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(ciWaitSteps(host, runId)).toEqual(["ci-wait:0", "ci-wait:1"]);
    expect(scenario.now()).toBeGreaterThan(TIMEOUT_MS);
  });

  it("waits again when the window's last read hit an HTTP 503, and reaches the merge decision once the checks go green", async () => {
    const scenario = landScenario({ ciTimeoutMs: TIMEOUT_MS });
    scenario.fake.onGetPr = (pr) => scenario.fake.setRuns(pr.headSha, scenario.now() >= 50 * MIN ? GREEN : []);
    const getPr = scenario.fake.wire.getPr;
    scenario.fake.wire.getPr = async (...args) => {
      if (scenario.now() >= 40 * MIN && scenario.now() < 50 * MIN) throw new FakeHttpError(503, "Service Unavailable");
      return getPr(...args);
    };
    const { host, runId } = start(scenario);

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(ciWaitSteps(host, runId)).toEqual(["ci-wait:0", "ci-wait:1"]);
  });

  it("fails naming the attempt count once every attempt times out", async () => {
    const scenario = unsettledUntil(Number.POSITIVE_INFINITY);
    const { host, runId } = start(scenario);

    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("failed");
    expect(run.error).toContain(`ci-wait timed out after ${TIMEOUT_MS} ms on each of ${CI_WAIT_ATTEMPTS} attempts: waiting on mergeable_state unknown`);
    expect(ciWaitSteps(host, runId)).toHaveLength(CI_WAIT_ATTEMPTS);
    expect(scenario.now()).toBeGreaterThanOrEqual(CI_WAIT_ATTEMPTS * TIMEOUT_MS);
  });

  it("returns a red check at once, with no re-wait, when it turns red during a re-wait", async () => {
    const red = outsideActions({ ...successRun("validate", 1), conclusion: "failure" });
    const scenario = unsettledUntil(50 * MIN, GREEN, [red, successRun("dag-check", 2)]);
    const { host, runId } = start(scenario);

    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "ci-failed", failing: [{ name: "validate" }] });
    expect(ciWaitSteps(host, runId)).toEqual(["ci-wait:0", "ci-wait:1"]);
    expect(scenario.now()).toBeLessThan(2 * TIMEOUT_MS);
  });

  it("still fails at the first timeout when a required check never reported", async () => {
    const scenario = landScenario({ ciTimeoutMs: TIMEOUT_MS });
    scenario.fake.onGetPr = (pr) => scenario.fake.setRuns(pr.headSha, [successRun("validate", 1)]);
    const { host, runId } = start(scenario);

    const run = await host.runtime.wait(runId);

    expect(run.error).toContain(`ci-wait timed out after ${TIMEOUT_MS} ms: waiting on dag-check`);
    expect(ciWaitSteps(host, runId)).toEqual([]);
  });
});
