import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSha, ghCliWire, githubPort, type GhExec } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_EVERYTHING_RULE } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, approveUntilSettled, gateId, gateOpened, landScenario, type LandScenario } from "../test-support/land.js";
import { MAX_UPDATE_CYCLES, landRoutes } from "./land.js";
import type { StepRoute } from "../routed-runner.js";

const FOREIGN = fakeSha("foreign1");
const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function dbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-land-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

function hostFor(scenario: LandScenario, dbPath = ":memory:"): FactoryHost {
  const host = openFactoryHost({ dbPath, workflows: [scenario.workflow], routes: scenario.routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}


describe("land core", () => {
  it("merges with the head its own update-branch produced after the approved head fell behind", async () => {
    const scenario = landScenario();
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    scenario.fake.pr(1).behind = true;
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });
    const run = await host.runtime.wait(runId);

    const pr = scenario.fake.pr(1);
    expect(run.status).toBe("completed");
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 1, merge: 1 });
    expect(scenario.fake.commits.get(pr.headSha)?.parents[0]).toBe(H1);
    expect(scenario.outcomes.at(-1)).toEqual({ kind: "merged", headSha: pr.headSha, mergeSha: pr.mergeSha });
    expect(host.gates.get(gateId(runId, "approve-merge", 1))).toBeUndefined();
  });

  it("still asks for approval of a head its own update produced before any approval", async () => {
    const scenario = landScenario();
    scenario.fake.pr(1).behind = true;
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(scenario.fake.pr(1).headSha);
    expect(scenario.fake.commits.get(scenario.fake.pr(1).headSha)?.parents[0]).toBe(H1);
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 1, merge: 0 });
  });

  it("performs zero merge calls while the approve-merge gate is unresolved, even across a resume", async () => {
    const scenario = landScenario();
    const dbPath = dbFile();
    const first = hostFor(scenario, dbPath);
    const runId = first.runtime.start("land-test");
    await gateOpened(first, gateId(runId, "approve-merge"));
    first.close();

    const report = await hostFor(scenario, dbPath).resume();

    expect(report.gates.map((pending) => pending.gate.id)).toEqual([gateId(runId, "approve-merge")]);
    expect(scenario.fake.calls).not.toContain("merge");
    expect(scenario.fake.effects.merge).toBe(0);
  });

  it("stops without a gate or a merge when the policy denies the merge", async () => {
    const scenario = landScenario({ policy: { decide: () => ({ outcome: "deny", rule: GATE_EVERYTHING_RULE, reason: "frozen" }) } });
    const host = hostFor(scenario);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run.status).toBe("completed");
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "stopped", reason: "merge-denied" });
    expect(host.gates.listPending()).toEqual([]);
    expect(scenario.fake.calls).not.toContain("merge");
  });

  it(`opens stuck-behind instead of a ${MAX_UPDATE_CYCLES + 1}th update when the base keeps moving, and never merges`, async () => {
    const scenario = landScenario();
    const keepGreen = scenario.fake.onGetPr!;
    scenario.fake.onGetPr = (pr, reads) => (keepGreen(pr, reads), (pr.behind = true));
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "stuck-behind"));

    host.runtime.signal(runId, "stuck-behind", { decision: "abandon" });
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(scenario.fake.effects).toMatchObject({ updateBranch: MAX_UPDATE_CYCLES, merge: 0 });
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "stopped", reason: "stuck-behind" });
    expect(host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
  });

  it("never merges while mergeable_state reads unknown: ci-wait times out and the run fails", async () => {
    const scenario = landScenario({ ciTimeoutMs: 10 * 60_000 });
    scenario.fake.pr(1).mergeableState = "unknown";
    const host = hostFor(scenario);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("mergeable_state unknown") });
    expect(host.gates.listPending()).toEqual([]);
    expect(scenario.fake.calls).not.toContain("merge");
  });

  it("does not merge an approved head once mergeable_state turns unknown", async () => {
    const scenario = landScenario({ ciTimeoutMs: 10 * 60_000 });
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    scenario.fake.pr(1).mergeableState = "unknown";
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("failed");
    expect(scenario.fake.calls).not.toContain("merge");
  });

  it("asks again when a commit this run did not make lands after the approval", async () => {
    const scenario = landScenario();
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    scenario.fake.pushHead(1, FOREIGN);
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });
    await gateOpened(host, gateId(runId, "approve-merge", 1));
    const mergesBeforeSecondApproval = scenario.fake.effects.merge;
    await approveUntilSettled(host, runId, scenario.fake);

    expect(mergesBeforeSecondApproval).toBe(0);
    expect(scenario.fake.effects.merge).toBe(1);
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: FOREIGN });
  });

  it("refuses an approval that names a head other than the one shown, and does not merge", async () => {
    const scenario = landScenario();
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    const answer = () => host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: fakeSha("other") });

    expect(answer).toThrow(`headSha: expected "${H1}"`);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
    expect(scenario.fake.calls).not.toContain("merge");
  });

  it("returns ci-failed with the failing check and its Actions run, without asking to merge", async () => {
    const scenario = landScenario();
    scenario.fake.onGetPr = (pr) => scenario.fake.setRuns(pr.headSha, [{ id: 9, name: "validate", status: "completed", conclusion: "failure", startedAt: null, headSha: pr.headSha, appId: 15368, workflowRunId: 77, url: "u" }]);
    const host = hostFor(scenario);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run.status).toBe("completed");
    expect(scenario.outcomes.at(-1)).toEqual({ kind: "ci-failed", headSha: H1, failing: [{ name: "validate", conclusion: "failure", url: "u", workflowRunId: 77 }] });
    expect(host.gates.listPending()).toEqual([]);
  });

  it("stores a failed step's gh error without the token-shaped text gh printed", async () => {
    const leaked = `ghp_${"Z9y8".repeat(9)}`;
    const exec: GhExec = async () => ({ code: 1, stdout: "", stderr: `gh: Bad credentials; Authorization: token ${leaked} (HTTP 401)\n` });
    const scenario = landScenario();
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [scenario.workflow], routes: landRoutes({ port: githubPort(ghCliWire(exec)) }), gatePollMs: 5 });
    hosts.push(host);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("Bad credentials") });
    expect(JSON.stringify(run)).not.toContain(leaked);
    expect(JSON.stringify(run)).not.toContain("Z9y8");
  });

  it("writes one evidence record per step with the run as trace and the step attempt as span", async () => {
    const scenario = landScenario();
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));
    await approveUntilSettled(host, runId, scenario.fake);

    const results = Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.output);
    const records = results.map((result) => JSON.parse(result.output!));

    expect(records.map((record) => record.kind)).toEqual(["land.land-rules", "land.ci-wait", "land.merge-policy", "land.ci-wait", "land.merge"]);
    expect(records.every((record) => record.v === 1 && record.traceId === runId)).toBe(true);
    expect(records[4].spanId).toBe(`workflow:${runId}:merge%3A0:0:0`);
  });

  it("fails a step whose evidence record lacks result, so the branch never reads undefined", async () => {
    const scenario = landScenario();
    const dropResult = (record: Record<string, unknown>) => (({ result: _result, ...rest }) => rest)(record);
    const host = hostFor({ ...scenario, routes: rewriteRecords(scenario.routes, "land-rules", dropResult) });

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run.status).toBe("failed");
    expect(run.error).toContain("output schema: result");
    expect(scenario.outcomes).toEqual([]);
  });

  it("keeps a code step's titan.trace.artifacts key in the stored step result", async () => {
    const scenario = landScenario();
    const artifacts = [{ kind: "note", ref: "synthetic" }];
    const host = hostFor({ ...scenario, routes: rewriteRecords(scenario.routes, "land-rules", (record) => ({ ...record, "titan.trace.artifacts": artifacts })) });
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(host.runtime.status(runId)!.stepResults["land-rules:0"]!.data).toMatchObject({ "titan.trace.artifacts": artifacts });
  });
});

/** Rewrites the evidence record a matching code route writes, to stand in for a route that answers differently. */
function rewriteRecords(routes: StepRoute[], match: string, edit: (record: Record<string, unknown>) => Record<string, unknown>): StepRoute[] {
  return routes.map((route) => {
    if (route.match !== match) return route;
    const run: StepRoute["runner"]["run"] = async (input) => {
      const outcome = await route.runner.run(input);
      return outcome.ok ? { ...outcome, output: JSON.stringify(edit(JSON.parse(outcome.output!))) } : outcome;
    };
    return { ...route, runner: { ...route.runner, run } };
  });
}
