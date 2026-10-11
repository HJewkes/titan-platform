import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { requireRequiredChecks } from "./required-checks.js";
import { H1, approveUntilSettled, landScenario } from "./test-support/land.js";
import { decideAutoMerge, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./shepherd/merge-facts.js";

const REPO = "octo/demo";
const HEAD = fakeSha("required-checks-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const UNREADABLE = [
  ["a port error", new Error("socket hang up"), "no HTTP status"],
  ["an HTTP 403", new FakeHttpError(403, "rulesets need GitHub Pro"), "HTTP 403"],
  ["an HTTP 404", new FakeHttpError(404, "not found"), "HTTP 404"],
] as const;

function failRulesWith(fake: FakeGitHub, error: Error): void {
  fake.wire.getBranchRules = async () => {
    throw error;
  };
}

function evidenceInput(): MergeEvidenceInput {
  const locator = { sourceId: "transcript-1" } as unknown as MergeEvidenceInput["verdict"]["locator"];
  return { runId: "run-1", repo: REPO, pr: 1, head: HEAD, verdict: { value: "MERGE", head: HEAD, locator }, resolver: REVIEWER, dispatchedReviewer: REVIEWER, seatGrants: ["merge-on-green-approve"] };
}

function greenWorld(): FakeGitHub {
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  return fake;
}

describe.each(UNREADABLE)("land when the required checks read fails with %s", (_name, error, status) => {
  it("stops at land-rules naming the repo and the status, and never merges", async () => {
    const scenario = landScenario();
    failRulesWith(scenario.fake, error);
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [scenario.workflow], routes: scenario.routes, gatePollMs: 5 });
    hosts.push(host);

    const runId = host.runtime.start("land-test");
    const run = await host.runtime.wait(runId).catch((failure: unknown) => failure);

    expect(JSON.stringify([run, host.runtime.status(runId)])).toContain(`required checks of octo/demo@main are unreadable: ${status}`);
    expect(scenario.fake.effects.merge).toBe(0);
    expect(host.runtime.status(runId)!.status).toBe("failed");
  });
});

describe.each(UNREADABLE)("merge facts when the required checks read fails with %s", (_name, error, status) => {
  it("gates and records the required checks as unknown, naming the repo and the status", async () => {
    const fake = greenWorld();
    failRulesWith(fake, error);

    const evidence = await mergeEvidence(githubPort(fake.wire), evidenceInput(), noFreezeStoreUntilTp523);
    const decision = decideAutoMerge(HEAD, evidence);

    expect(evidence.requiredChecksUnknown).toBe(`required checks of ${REPO}@main are unreadable: ${status}`);
    expect(decision).toMatchObject({ outcome: "gate", rule: { rowId: "required-checks-unknown" }, reason: evidence.requiredChecksUnknown });
  });
});

describe("merge facts when the repo has no rules", () => {
  it("keeps today's behavior: an empty read records no unknown and authority decides", async () => {
    const fake = greenWorld();
    fake.rules.contexts = [];

    const evidence = await mergeEvidence(githubPort(fake.wire), evidenceInput(), noFreezeStoreUntilTp523);

    expect(evidence.requiredChecksUnknown).toBeUndefined();
    expect(evidence.merge.requiredContexts).toEqual([]);
  });
});

const PRO_403 = new FakeHttpError(403, "Upgrade to GitHub Pro or make this repository public to enable this feature.");

function freePlanRepo(protectedBranch: boolean, runs: CheckRun[], ciTimeoutMs?: number) {
  const scenario = landScenario({ ciTimeoutMs });
  failRulesWith(scenario.fake, PRO_403);
  scenario.fake.branchProtected = protectedBranch;
  scenario.fake.onGetPr = (pr) => scenario.fake.setRuns(pr.headSha, runs);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [scenario.workflow], routes: scenario.routes, gatePollMs: 5 });
  hosts.push(host);
  return { scenario, host, runId: host.runtime.start("land-test") };
}

describe("land on a free-plan repo whose rules read answers the Pro 403", () => {
  it("lands when the branch reports protected:false and every check-run is green", async () => {
    const { scenario, host, runId } = freePlanRepo(false, [successRun("lint", 1), successRun("test", 2)]);

    await approveUntilSettled(host, runId, scenario.fake);

    expect(host.runtime.status(runId)!.status).toBe("completed");
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: H1 });
    expect(scenario.fake.effects.merge).toBe(1);
  });

  it("refuses to merge while a check-run is red", async () => {
    const { scenario, host, runId } = freePlanRepo(false, [successRun("lint", 1), successRun("test", 2, undefined, "failure", undefined, H1)]);

    await host.runtime.wait(runId).catch(() => undefined);

    expect(scenario.fake.effects.merge).toBe(0);
    expect(scenario.outcomes.at(-1)).toMatchObject({ kind: "ci-failed" });
  });

  it("refuses to merge while a check-run is pending", async () => {
    const pending: CheckRun = { ...successRun("test", 2, undefined, "success", undefined, H1), status: "in_progress", conclusion: null };
    const { scenario, host, runId } = freePlanRepo(false, [successRun("lint", 1), pending], 60);

    await host.runtime.wait(runId).catch(() => undefined);

    expect(scenario.fake.effects.merge).toBe(0);
    expect(host.runtime.status(runId)!.status).toBe("failed");
  });

  it("refuses when the branch reports protected:true", async () => {
    const { scenario, host, runId } = freePlanRepo(true, [successRun("lint", 1)]);

    const run = await host.runtime.wait(runId).catch((failure: unknown) => failure);

    expect(JSON.stringify([run, host.runtime.status(runId)])).toContain("required checks of octo/demo@main are unreadable: HTTP 403");
    expect(scenario.fake.effects.merge).toBe(0);
  });
});

describe("requireRequiredChecks on a 403", () => {
  const port = (rulesError: Error, branch: boolean | Error) => {
    const fake = fakeGitHub({ repo: REPO });
    failRulesWith(fake, rulesError);
    fake.wire.getBranchProtected = async () => {
      if (branch instanceof Error) throw branch;
      return branch;
    };
    return githubPort(fake.wire);
  };

  it("reads the Pro 403 with protected:false as a repo with no rules", async () => {
    await expect(requireRequiredChecks(port(PRO_403, false), REPO, "main")).resolves.toEqual({ contexts: [], strict: false });
  });

  it("refuses the Pro 403 when the branch read fails, so protected is never inferred", async () => {
    await expect(requireRequiredChecks(port(PRO_403, new FakeHttpError(500, "boom")), REPO, "main")).rejects.toThrow("unreadable: HTTP 403; land refuses");
  });

  it("refuses a generic 403 even when the branch reports protected:false", async () => {
    const generic = new FakeHttpError(403, "Resource not accessible by integration");
    await expect(requireRequiredChecks(port(generic, false), REPO, "main")).rejects.toThrow("unreadable: HTTP 403; land refuses");
  });

  it("refuses a Pro message that carries another status", async () => {
    const wrongStatus = new FakeHttpError(404, "Upgrade to GitHub Pro");
    await expect(requireRequiredChecks(port(wrongStatus, false), REPO, "main")).rejects.toThrow("unreadable: HTTP 404; land refuses");
  });
});
