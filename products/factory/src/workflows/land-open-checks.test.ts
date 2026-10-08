import { fakeSha, successRun, type CheckRun } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, approveUntilSettled, landScenario, type LandScenario } from "../test-support/land.js";
import { openRepoFindings } from "./land-open-checks.js";

const HEAD = fakeSha("open-head");
const OTHER_APP = 99;
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const run = (name: string, id: number, conclusion = "success", appId?: number): CheckRun => successRun(name, id, undefined, conclusion, appId, HEAD);
const queued = (name: string, id: number): CheckRun => ({ ...run(name, id), status: "in_progress", conclusion: null });

describe("openRepoFindings", () => {
  it("is empty when every Actions run at the head is green", () => {
    expect(openRepoFindings(HEAD, [run("a", 1), run("b", 2, "neutral"), run("c", 3, "skipped")])).toEqual([]);
  });

  it("is a missing finding when no run reported, so an empty set never lands", () => {
    expect(openRepoFindings(HEAD, [])).toEqual([{ kind: "missing", name: expect.any(String) }]);
  });

  it("reports a failed and a cancelled run as failed", () => {
    const kinds = openRepoFindings(HEAD, [run("a", 1, "failure"), run("b", 2, "cancelled"), run("c", 3)]).map((finding) => finding.kind);
    expect(kinds).toEqual(["failed", "failed"]);
  });

  it("reports an unfinished run as pending", () => {
    expect(openRepoFindings(HEAD, [run("a", 1), queued("b", 2)]).map((finding) => finding.kind)).toEqual(["pending"]);
  });

  it("neither counts nor blocks on another app's run", () => {
    expect(openRepoFindings(HEAD, [run("a", 1), run("ext", 2, "failure", OTHER_APP)])).toEqual([]);
    expect(openRepoFindings(HEAD, [run("ext", 2, "success", OTHER_APP)]).map((finding) => finding.kind)).toEqual(["missing"]);
  });

  it("ignores runs at another head", () => {
    expect(openRepoFindings(HEAD, [{ ...run("a", 1), headSha: fakeSha("elsewhere") }]).map((finding) => finding.kind)).toEqual(["missing"]);
  });
});

/** A workout-analytics-shaped repo: no ruleset, so the base requires no status checks. */
function openScenario(runs: CheckRun[], ciTimeoutMs?: number): LandScenario {
  const scenario = landScenario({ ciTimeoutMs });
  scenario.fake.rules.contexts = [];
  scenario.fake.onGetPr = (pr) => scenario.fake.setRuns(pr.headSha, runs);
  return scenario;
}

function start(scenario: LandScenario): { host: FactoryHost; runId: string } {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [scenario.workflow], routes: scenario.routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, runId: host.runtime.start("land-test") };
}

const actions = [successRun("lint", 1), successRun("test", 2), successRun("build", 3)];

describe("land on a repo whose base requires no status checks", () => {
  it("lands when every Actions check-run at the head is green", async () => {
    const scenario = openScenario(actions);
    const { host, runId } = start(scenario);

    await approveUntilSettled(host, runId, scenario.fake);

    expect(host.runtime.status(runId)!.status).toBe("completed");
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: H1 });
    expect(scenario.fake.effects.merge).toBe(1);
  });

  it("never lands with zero check-runs, and times out through ci-wait", async () => {
    const scenario = openScenario([], 60_000);
    const { host, runId } = start(scenario);

    const result = await host.runtime.wait(runId).catch((failure: unknown) => failure);

    expect(JSON.stringify([result, host.runtime.status(runId)])).toContain("ci-wait timed out");
    expect(scenario.fake.effects.merge).toBe(0);
  });

  it("reads a red Actions check-run as ci-failed", async () => {
    const scenario = openScenario([successRun("lint", 1), successRun("test", 2, undefined, "failure"), successRun("build", 3)]);
    const { host, runId } = start(scenario);

    await host.runtime.wait(runId);

    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "ci-failed", failing: [{ name: "test", conclusion: "failure" }] });
    expect(scenario.fake.effects.merge).toBe(0);
  });

  it("never lands on a green check-run from another app with no Actions runs", async () => {
    const scenario = openScenario([successRun("external", 1, undefined, "success", OTHER_APP)], 60_000);
    const { host, runId } = start(scenario);

    const result = await host.runtime.wait(runId).catch((failure: unknown) => failure);

    expect(JSON.stringify([result, host.runtime.status(runId)])).toContain("ci-wait timed out");
    expect(scenario.fake.effects.merge).toBe(0);
  });

  it("still waits on the required contexts of a repo that names them", async () => {
    const scenario = landScenario({ ciTimeoutMs: 60_000 });
    scenario.fake.onGetPr = (pr) => scenario.fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("lint", 3)]);
    const { host, runId } = start(scenario);

    const result = await host.runtime.wait(runId).catch((failure: unknown) => failure);

    expect(JSON.stringify([result, host.runtime.status(runId)])).toContain("waiting on dag-check");
    expect(scenario.fake.effects.merge).toBe(0);
  });
});
