import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { landScenario } from "./test-support/land.js";
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
