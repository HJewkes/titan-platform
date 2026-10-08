import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHttpError, fakeGitHub, fakeSha, ghCliWire, githubPort, successRun, type CheckRun, type GhExec } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { GATE_EVERYTHING_RULE } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { expectBrief } from "../test-support/brief.js";
import { H1, approveUntilSettled, gateId, gateOpened, landScenario, swallowUpdates, type LandScenario } from "../test-support/land.js";
import { MAX_UPDATE_CYCLES, MAX_UPDATE_RETRIES, landRoutes, readCi } from "./land.js";
import type { StepRoute } from "@titan-design/workflow";
import { OWNER } from "../test-support/resolver.js";

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
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    const run = await host.runtime.wait(runId);

    const pr = scenario.fake.pr(1);
    expect(run.status).toBe("completed");
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 1, merge: 1 });
    expect(scenario.fake.commits.get(pr.headSha)?.parents[0]).toBe(H1);
    expect(scenario.outcomes.at(-1)).toEqual({ kind: "merged", headSha: pr.headSha, mergeSha: pr.mergeSha });
    expect(host.gates.get(gateId(runId, "approve-merge", 1))).toBeUndefined();
  });

  it("re-sends update-branch when the head has not moved and merges once the second write lands", async () => {
    const scenario = landScenario();
    swallowUpdates(scenario.fake, 1);
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    scenario.fake.pr(1).behind = true;
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    const run = await host.runtime.wait(runId);

    const pr = scenario.fake.pr(1);
    expect(run.status).toBe("completed");
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 1, merge: 1 });
    expect(scenario.outcomes.at(-1)).toEqual({ kind: "merged", headSha: pr.headSha, mergeSha: pr.mergeSha });
  });

  it("stops as update-branch-unmoved after two re-sends when the head never moves", async () => {
    const scenario = landScenario();
    swallowUpdates(scenario.fake, 99);
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    scenario.fake.pr(1).behind = true;
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(scenario.fake.calls.filter((call) => call === "updateBranch:swallowed")).toHaveLength(3);
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 0, merge: 0 });
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "stopped", reason: "update-branch-unmoved", headSha: H1 });
  });

  it("reports a null merge sha for a PR GitHub shows merged with no merge commit", async () => {
    const scenario = landScenario();
    Object.assign(scenario.fake.pr(1), { merged: true, state: "closed", mergeSha: null });
    const host = hostFor(scenario);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run.status).toBe("completed");
    expect(scenario.fake.effects.merge).toBe(0);
    expect(scenario.outcomes.at(-1)).toEqual({ kind: "merged", headSha: H1, mergeSha: null });
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

  it("opens approve-merge with a summary naming the head and an evidence link", async () => {
    const scenario = landScenario();
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    expectBrief(host.gates.get(gateId(runId, "approve-merge")), H1, /^https:\/\/github\.com\/octo\/demo\/pull\/1$/);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.questions?.[0]?.options).not.toContainEqual(expect.objectContaining({ recommended: true }));
  });

  it("opens stuck-behind with a summary naming the head and an evidence link", async () => {
    const scenario = landScenario();
    const keepGreen = scenario.fake.onGetPr!;
    scenario.fake.onGetPr = (pr, reads) => (keepGreen(pr, reads), (pr.behind = true));
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "stuck-behind"));

    expectBrief(host.gates.get(gateId(runId, "stuck-behind")), scenario.fake.pr(1).headSha, /^https:\/\/github\.com\/octo\/demo\/pull\/1$/);
  });

  it(`retries ${MAX_UPDATE_RETRIES} times with a growing wait, then opens stuck-behind naming the retries, and never merges`, async () => {
    const scenario = landScenario();
    const keepGreen = scenario.fake.onGetPr!;
    scenario.fake.onGetPr = (pr, reads) => (keepGreen(pr, reads), (pr.behind = true));
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "stuck-behind"));

    expect(host.gates.get(gateId(runId, "stuck-behind"))?.prompt).toContain(`after ${MAX_UPDATE_CYCLES} updates and ${MAX_UPDATE_RETRIES} automatic retries with backoff`);
    host.runtime.signal(runId, "stuck-behind", { decision: "abandon" }, OWNER);
    const run = await host.runtime.wait(runId);

    const waits = Object.entries(run.stepResults).filter(([id]) => id.startsWith("update-backoff")).map(([, result]) => (result.data as { result: { waitMs: number } }).result.waitMs);
    expect(waits).toEqual([2, 4, 8].map((min) => min * 60_000));
    expect(scenario.fake.effects).toMatchObject({ updateBranch: MAX_UPDATE_CYCLES + MAX_UPDATE_RETRIES, merge: 0 });
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "stopped", reason: "stuck-behind" });
  });

  it("opens no stuck-behind gate when a retry lands and the base holds, then restarts the budget", async () => {
    const scenario = landScenario();
    const keepGreen = scenario.fake.onGetPr!;
    scenario.fake.onGetPr = (pr, reads) => (keepGreen(pr, reads), (pr.behind = scenario.fake.effects.updateBranch < MAX_UPDATE_CYCLES + 1));
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(host.gates.get(gateId(runId, "stuck-behind"))).toBeUndefined();
    expect(scenario.fake.effects).toMatchObject({ updateBranch: MAX_UPDATE_CYCLES + 1, merge: 0 });
    expect(Object.keys(host.runtime.status(runId)!.stepResults).filter((id) => id.startsWith("update-"))).toEqual(
      expect.arrayContaining(["update-backoff:0:0", "update-branch:3:0"]),
    );
  });

  it("stops with conflict, not a gate, when a retry's update hits a merge conflict", async () => {
    const scenario = landScenario();
    const keepGreen = scenario.fake.onGetPr!;
    scenario.fake.onGetPr = (pr, reads) => (keepGreen(pr, reads), (pr.behind = true), (scenario.fake.updateBranchConflict = scenario.fake.effects.updateBranch >= MAX_UPDATE_CYCLES));
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");

    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(host.gates.get(gateId(runId, "stuck-behind"))).toBeUndefined();
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "stopped", reason: "conflict" });
  });

  it("updates the branch and merges again when GitHub refuses a merge because the base moved", async () => {
    const scenario = landScenario();
    const refuse = refuseNextMerge(scenario, 405, "Base branch was modified. Review and try the merge again.");
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(refuse.attempts()).toBe(2);
    expect(scenario.fake.calls.filter((call) => /merge|updateBranch/.test(call))).toEqual(["merge:refused", "updateBranch", "merge"]);
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", mergeSha: scenario.fake.pr(1).mergeSha });
  });

  it.each([
    [405, "Pull Request is not mergeable"],
    [409, "Head branch was modified. Review and try the merge again."],
  ])("still fails the merge step on an HTTP %i that is not a moved base (%s)", async (status, message) => {
    const scenario = landScenario();
    refuseNextMerge(scenario, status, message);
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("failed");
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 0, merge: 0 });
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
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
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
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
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

    const answer = () => host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: fakeSha("other") }, OWNER);

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

const ALLOW = { decide: () => ({ outcome: "allow" as const, rule: GATE_EVERYTHING_RULE, reason: "synthetic allow" }) };
const GREEN_AT = "2026-01-01T00:00:00Z";
const PENDING_READS = 2;

/** A behind PR at H1, green since GREEN_AT, whose base tip was committed at `baseCommittedAt`; a new head goes green only after a few reads. */
function staleBaseScenario(options: { strict: boolean; baseCommittedAt: string }) {
  const scenario = landScenario({ policy: ALLOW });
  const { fake } = scenario;
  fake.rules.strict = options.strict;
  fake.pr(1).behind = true;
  const tip = fake.refs.get("main")!;
  fake.commits.set(tip, { sha: tip, parents: [], committedAt: options.baseCommittedAt });
  const reads = new Map<string, number>();
  const greenAtMerge: boolean[] = [];
  fake.onGetPr = (pr) => {
    const n = (reads.get(pr.headSha) ?? 0) + 1;
    reads.set(pr.headSha, n);
    const status = pr.headSha === H1 || n > PENDING_READS ? "completed" : "in_progress";
    fake.setRuns(pr.headSha, ["validate", "dag-check"].map((name, i) => ({ ...successRun(name, i + 1, GREEN_AT), status })));
  };
  const merge = fake.wire.merge;
  fake.wire.merge = async (...args) => (greenAtMerge.push((reads.get(args[2]) ?? 0) > PENDING_READS || args[2] === H1), merge(...args));
  return { ...scenario, greenAtMerge };
}

describe("land refreshes a head whose base moved after its last green run", () => {
  it("updates a non-strict branch whose base moved after green, and merges only once the new head is green", async () => {
    const scenario = staleBaseScenario({ strict: false, baseCommittedAt: "2026-01-01T00:10:00Z" });
    const host = hostFor(scenario);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    const head = scenario.fake.pr(1).headSha;
    expect(run.status).toBe("completed");
    expect(head).not.toBe(H1);
    expect(scenario.fake.commits.get(head)?.parents[0]).toBe(H1);
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 1, merge: 1 });
    expect(scenario.greenAtMerge).toEqual([true]);
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: head });
  });

  it("merges a non-strict branch without an update when its base has not moved since green", async () => {
    const scenario = staleBaseScenario({ strict: false, baseCommittedAt: "2025-12-31T23:50:00Z" });
    const host = hostFor(scenario);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run.status).toBe("completed");
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 0, merge: 1 });
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: H1 });
  });

  it("still updates a behind branch in a strict repo even when its base has not moved since green", async () => {
    const scenario = staleBaseScenario({ strict: true, baseCommittedAt: "2025-12-31T23:50:00Z" });
    const host = hostFor(scenario);

    const run = await host.runtime.wait(host.runtime.start("land-test"));

    expect(run.status).toBe("completed");
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 1, merge: 1 });
    expect(scenario.greenAtMerge).toEqual([true]);
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: scenario.fake.pr(1).headSha });
  });
});

describe("readCi on a blocked head", () => {
  async function blockedVerdict(options: { bypass: boolean; runs: CheckRun[]; state?: string }) {
    const fake = fakeGitHub({ repo: "octo/demo" });
    fake.reviewBypass = options.bypass;
    fake.addPr({ headSha: H1, mergeableState: options.state ?? "blocked" });
    fake.setRuns(H1, options.runs);
    const snapshot = await readCi(githubPort(fake.wire), { repo: "octo/demo", pr: 1, contexts: ["validate", "dag-check"], strict: true });
    return { snapshot, calls: fake.calls };
  }
  const green = [successRun("validate", 1), successRun("dag-check", 2)];

  it("is green when the approval rule is bypassable and every required context is green", async () => {
    expect((await blockedVerdict({ bypass: true, runs: green })).snapshot.verdict).toBe("green");
  });

  it("stays pending when the approval rule cannot be bypassed", async () => {
    expect((await blockedVerdict({ bypass: false, runs: green })).snapshot.verdict).toBe("pending");
  });

  it("stays pending without reading the bypass while a required context is still pending", async () => {
    const { snapshot, calls } = await blockedVerdict({ bypass: true, runs: [successRun("validate", 1)] });

    expect(snapshot.verdict).toBe("pending");
    expect(calls).not.toContain("reviewRulesBypassable");
  });

  it("stays not-mergeable when dirty, whatever the bypass says", async () => {
    expect((await blockedVerdict({ bypass: true, runs: green, state: "dirty" })).snapshot.verdict).toBe("not-mergeable");
  });
});

describe("land in a repo that does not require up-to-date heads", () => {
  it("asks for approval without updating, refreshes once after it, and merges though the base keeps moving", async () => {
    const scenario = landScenario();
    scenario.fake.rules.strict = false;
    const keepGreen = scenario.fake.onGetPr!;
    scenario.fake.onGetPr = (pr, reads) => (keepGreen(pr, reads), (pr.behind = true));
    const host = hostFor(scenario);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));
    const updatesBeforeApproval = scenario.fake.effects.updateBranch;

    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(updatesBeforeApproval).toBe(0);
    expect(scenario.fake.effects).toMatchObject({ updateBranch: 1, merge: 1 });
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged" });
    expect(host.gates.get(gateId(runId, "stuck-behind"))).toBeUndefined();
  });
});

describe("readCi on a behind head in a strict repo", () => {
  async function behindSnapshot(runs: CheckRun[], draft = false) {
    const fake = fakeGitHub({ repo: "octo/demo" });
    fake.addPr({ headSha: H1, mergeableState: "behind", behind: true, draft });
    fake.setRuns(H1, runs);
    return readCi(githubPort(fake.wire), { repo: "octo/demo", pr: 1, contexts: ["validate", "dag-check"], strict: true });
  }

  it("marks the head's own checks green, so it can be reviewed before an update", async () => {
    expect(await behindSnapshot([successRun("validate", 1), successRun("dag-check", 2)])).toMatchObject({ verdict: "behind", checksGreen: true });
  });

  it("waits rather than reads behind while a required check is running or missing, so an update never restarts unsettled CI", async () => {
    const running = [{ ...successRun("validate", 1), status: "in_progress", conclusion: null }, successRun("dag-check", 2)];
    const snapshots = [await behindSnapshot(running), await behindSnapshot([successRun("validate", 1)])];

    expect(snapshots).toMatchObject([
      { verdict: "pending", waitingOn: ["validate"] },
      { verdict: "pending", waitingOn: ["dag-check"] },
    ]);
  });

  it("leaves the mark off when a required check settled red, or the PR is a draft", async () => {
    const red = [successRun("validate", 1, undefined, "failure"), successRun("dag-check", 2)];
    const snapshots = [await behindSnapshot(red), await behindSnapshot([successRun("validate", 1), successRun("dag-check", 2)], true)];

    expect(snapshots.map((snapshot) => [snapshot.verdict, snapshot.checksGreen])).toEqual([["behind", undefined], ["behind", undefined]]);
  });
});

describe("readCi on a behind head in a non-strict repo", () => {
  async function behindVerdict(baseCommit: { committedAt?: string }, runs: CheckRun[]) {
    const fake = fakeGitHub({ repo: "octo/demo" });
    fake.rules.strict = false;
    fake.addPr({ headSha: H1, behind: true });
    const tip = fake.refs.get("main")!;
    fake.commits.set(tip, { sha: tip, parents: [], ...baseCommit });
    fake.setRuns(H1, runs);
    return (await readCi(githubPort(fake.wire), { repo: "octo/demo", pr: 1, contexts: ["validate", "dag-check"], strict: false })).verdict;
  }

  it("counts green from the earliest required run, so a base commit between the two runs is untested", async () => {
    const verdict = await behindVerdict({ committedAt: "2026-01-01T00:02:00Z" }, [successRun("validate", 1, EARLY), successRun("dag-check", 2, LATE)]);

    expect(verdict).toBe("behind");
  });

  it("treats a base tip with no commit date as moved", async () => {
    const verdict = await behindVerdict({}, [successRun("validate", 1, LATE), successRun("dag-check", 2, LATE)]);

    expect(verdict).toBe("behind");
  });

  it("dates the green from Actions runs only, so a later run from another app does not hide a moved base", async () => {
    const verdict = await behindVerdict({ committedAt: "2026-01-01T00:02:00Z" }, [successRun("validate", 1, EARLY), successRun("dag-check", 2, LATE), successRun("validate", 3, "2026-01-01T00:10:00Z", "success", OTHER_APP)]);

    expect(verdict).toBe("behind");
  });

  it("is green when the base tip predates every required run", async () => {
    const verdict = await behindVerdict({ committedAt: "2025-12-31T23:59:00Z" }, [successRun("validate", 1, EARLY), successRun("dag-check", 2, LATE)]);

    expect(verdict).toBe("green");
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

const OTHER_APP = 99;
const EARLY = "2026-01-01T00:00:00Z";
const LATE = "2026-01-01T00:05:00Z";

/** readCi over one PR at H1 whose required contexts are validate and dag-check, showing `runs`. */
async function verdictFor(runs: CheckRun[]) {
  const fake = fakeGitHub({ repo: "octo/demo" });
  fake.addPr({ headSha: H1 });
  fake.setRuns(H1, runs);
  return readCi(githubPort(fake.wire), { repo: "octo/demo", pr: 1, contexts: ["validate", "dag-check"], strict: true });
}

describe("readCi judges every run at the head", () => {
  it("is red when a required context has an older red run beside a newer green one", async () => {
    const snapshot = await verdictFor([successRun("validate", 1, EARLY, "failure"), successRun("validate", 2, LATE), successRun("dag-check", 3)]);

    expect(snapshot).toMatchObject({ verdict: "red", failing: [{ name: "validate", conclusion: "failure", workflowRunId: 1001 }] });
  });

  it.each(["neutral", "skipped"])("is red when a required context concluded %s", async (conclusion) => {
    const snapshot = await verdictFor([successRun("validate", 1, EARLY, conclusion), successRun("dag-check", 2)]);

    expect(snapshot).toMatchObject({ verdict: "red", failing: [{ name: "validate", conclusion }] });
  });

  it("is green when every required context concluded success", async () => {
    const snapshot = await verdictFor([successRun("validate", 1), successRun("dag-check", 2)]);

    expect(snapshot.verdict).toBe("green");
  });

  it("ignores a red run of a non-required context from an app outside the allowed set", async () => {
    const snapshot = await verdictFor([successRun("validate", 1), successRun("dag-check", 2), successRun("codecov", 3, EARLY, "failure", OTHER_APP)]);

    expect(snapshot.verdict).toBe("green");
  });

  it("is red on a red Actions run of a non-required context, as mergeReadiness is", async () => {
    const snapshot = await verdictFor([successRun("validate", 1), successRun("dag-check", 2), successRun("lint-extra", 3, EARLY, "failure")]);

    expect(snapshot).toMatchObject({ verdict: "red", failing: [{ name: "lint-extra" }] });
  });

  it("waits on a required context that only an app outside the allowed set reported", async () => {
    const snapshot = await verdictFor([successRun("validate", 1, EARLY, "success", OTHER_APP), successRun("dag-check", 2)]);

    expect(snapshot).toMatchObject({ verdict: "pending", waitingOn: ["validate"] });
  });
});

/** The next wire merge fails like GitHub and leaves the PR behind, as when another PR lands first. */
function refuseNextMerge(scenario: LandScenario, status: number, message: string): { attempts: () => number } {
  const { fake } = scenario;
  const merge = fake.wire.merge;
  let attempts = 0;
  fake.wire.merge = async (...args) => {
    if (attempts++ > 0) return merge(...args);
    fake.calls.push("merge:refused");
    fake.pr(1).behind = true;
    throw new FakeHttpError(status, message);
  };
  return { attempts: () => attempts };
}
