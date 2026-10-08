import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, approveUntilSettled, landScenario, type LandScenario } from "../test-support/land.js";
import { readCi } from "./land-ci.js";
import { openRepoFindings, openRunsSettled, openRunsSignature } from "./land-open-checks.js";

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

describe("holding an open repo's green for a second read", () => {
  it("signs the Actions runs at the head by id, ignoring other apps and heads", () => {
    const runs = [run("b", 2), run("a", 1), run("ext", 9, "success", OTHER_APP), { ...run("old", 7), headSha: fakeSha("elsewhere") }];
    expect(openRunsSignature(HEAD, runs)).toBe("1,2");
  });

  it("settles a run set only when the previous poll saw the same one", () => {
    const seen = {};
    const settled = [[run("a", 1)], [run("a", 1), run("b", 2)], [run("a", 1), run("b", 2)]].map((runs) => openRunsSettled(seen, HEAD, runs));
    expect(settled).toEqual([false, false, true]);
  });
});

describe("readCi on a repo whose base requires no status checks", () => {
  const input = { repo: "octo/demo", pr: 1, contexts: [], strict: false };

  function world(state: { mergeableState: string; behind: boolean }) {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1, ...state });
    fake.setRuns(H1, [successRun("lint", 1)]);
    return { fake, port: githubPort(fake.wire) };
  }

  it("reads pending on the first poll and green once the next poll sees the same runs", async () => {
    const { port } = world({ mergeableState: "clean", behind: false });
    const seen = {};
    const verdicts = [(await readCi(port, input, undefined, { openSeen: seen })).verdict, (await readCi(port, input, undefined, { openSeen: seen })).verdict];
    expect(verdicts).toEqual(["pending", "green"]);
  });

  it("holds a behind head whose base moved just as it holds a green one, so a late run is read before any refresh", async () => {
    const { fake, port } = world({ mergeableState: "clean", behind: true });
    const seen = {};

    const first = await readCi(port, input, undefined, { openSeen: seen });
    fake.setRuns(H1, [successRun("lint", 1), successRun("test", 2, undefined, "failure")]);
    const second = await readCi(port, input, undefined, { openSeen: seen });

    expect(first.verdict).toBe("pending");
    expect(second).toMatchObject({ verdict: "red", failing: [{ name: "test" }] });
  });

  it("reaches behind with baseMoved only on a poll that repeats the previous run set", async () => {
    const { port } = world({ mergeableState: "clean", behind: true });
    const seen = {};

    await readCi(port, input, undefined, { openSeen: seen });

    expect(await readCi(port, input, undefined, { openSeen: seen })).toMatchObject({ verdict: "behind", checksGreen: true, baseMoved: true });
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

  it("does not land on a green read taken before a later job's run existed", async () => {
    const scenario = landScenario();
    scenario.fake.rules.contexts = [];
    let reads = 0;
    // read 1 is land-rules; read 2 is the first ci-wait poll, when only the first job had a run
    scenario.fake.onGetPr = (pr) => scenario.fake.setRuns(pr.headSha, ++reads <= 2 ? [successRun("lint", 1)] : [successRun("lint", 1), successRun("test", 2, undefined, "failure")]);
    const { host, runId } = start(scenario);

    await host.runtime.wait(runId);

    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "ci-failed", failing: [{ name: "test" }] });
    expect(scenario.fake.effects.merge).toBe(0);
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
