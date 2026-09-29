import { evaluate } from "@titan-design/authority";
import type * as Authority from "@titan-design/authority";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { LAND_STEPS, land, landRoutes } from "../workflows/land.js";
import { decideAutoMerge, evidenceMarker, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { shepherdLandOptions, type EffectivePolicy } from "./policy.js";
import { REVIEW_STEPS, mergeVerdict, reviewRoutes } from "./review.js";
import { shepherdStoreRef } from "./store.js";

vi.mock("@titan-design/authority", async (importOriginal) => {
  const actual = await importOriginal<typeof Authority>();
  return { ...actual, evaluate: vi.fn(actual.evaluate) };
});

const REPO = "octo/demo";
const HEAD = fakeSha("merge-facts-head");
const OTHER_HEAD = fakeSha("merge-facts-other-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };
const locator = { sourceId: "transcript-1", selector: { kind: "subrecord-text" } } as unknown as SourceTextLocator;
const ALLOW_ALL = { verdict: "allow", ruleId: "MRG-AU-RV" } as const;

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
};

/** An open PR at HEAD whose required contexts are green from GitHub Actions and whose test merge is clean. */
function world(files: PrFile[] = [{ path: "src/a.ts", status: "modified" }]): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, files);
  return fake;
}

async function collect(fake: FakeGitHub, overrides: Partial<MergeEvidenceInput> = {}) {
  return mergeEvidence(githubPort(fake.wire), { ...input, ...overrides }, noFreezeStoreUntilTp523);
}

afterEach(() => vi.mocked(evaluate).mockReset());

describe("mergeEvidence", () => {
  it("allows by authority/MRG-AU-RV when all eight conditions hold, and posts one comment carrying the record", async () => {
    const fake = world();

    const evidence = await collect(fake);

    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV" } });
    expect(evidence.record).toMatchObject({ head: HEAD, baseRef: "main", testMergeSha: fakeSha("test-merge"), reviewer: REVIEWER, verdictLocator: locator });
    expect(evidence.record.checkRuns).toEqual([
      { name: "validate", id: 1, appId: 15368, conclusion: "success" },
      { name: "dag-check", id: 2, appId: 15368, conclusion: "success" },
    ]);
    const comments = fake.comments.get(1) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body.split("\n")[0]).toBe(evidenceMarker(HEAD));
    expect(comments[0]!.body).toContain('"rowId": "MRG-AU-RV"');
  });

  it("posts no second comment when the step repeats or another run collects at the same head", async () => {
    const fake = world();

    await collect(fake);
    await collect(fake);
    await collect(fake, { runId: "run-2" });

    expect(fake.comments.get(1)).toHaveLength(1);
  });

  it("gates, not allows, when a required context is still pending at the head", async () => {
    const fake = world();
    fake.setRuns(HEAD, [successRun("validate", 1, undefined, null as unknown as string), successRun("dag-check", 2)]);

    const evidence = await collect(fake);

    expect(evidence.record.decision.outcome).toBe("gate");
    expect(evidence.record.decision.reason).toContain("required-contexts-green");
  });

  it("does not count a check run named like a required context from an app other than GitHub Actions", async () => {
    const fake = world();
    fake.setRuns(HEAD, [successRun("validate", 1, undefined, "success", 999), successRun("dag-check", 2)]);

    expect((await collect(fake)).record.decision.outcome).toBe("gate");
  });

  it("gates a diff under .github/ even when authority allows everything", async () => {
    const fake = world([{ path: ".github/workflows/ci.yml", status: "modified" }]);
    vi.mocked(evaluate).mockReturnValue(ALLOW_ALL);

    const evidence = await collect(fake);

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: { rowId: "github-path" } });
  });

  it("collects the source of a rename, so moving a file out of .github/ gates even when authority allows everything", async () => {
    const fake = world([{ path: "tools/x.yml", previousPath: ".github/actions/x.yml", status: "renamed" }]);

    const evidence = await collect(fake);

    expect(evidence.merge.changedPaths).toEqual(["tools/x.yml", ".github/actions/x.yml"]);
    vi.mocked(evaluate).mockReturnValueOnce(ALLOW_ALL);
    expect(decideAutoMerge(HEAD, evidence)).toMatchObject({ outcome: "gate", rule: { rowId: "github-path" } });
  });

  it("folds case and trailing dots when it looks for .github", () => {
    const evidence = { head: HEAD, merge: { head: HEAD, changedPaths: [".GitHub./workflows/x.yml"] }, record: { repo: REPO, pr: 1 } } as unknown as MergeEvidence;
    vi.mocked(evaluate).mockReturnValueOnce(ALLOW_ALL);

    expect(decideAutoMerge(HEAD, evidence).rule.rowId).toBe("github-path");
  });

  it("gates facts collected at one head when the decision is for another", async () => {
    const evidence = await collect(world());

    expect(decideAutoMerge(HEAD, evidence).outcome).toBe("allow");
    expect(decideAutoMerge(OTHER_HEAD, evidence)).toMatchObject({ outcome: "gate", rule: { rowId: "head-mismatch" } });
  });

  it("reports the test merge unclean once the head has moved past the reviewed one", async () => {
    const fake = world();
    fake.pushHead(1, OTHER_HEAD);

    const evidence = await collect(fake);

    expect(evidence.merge.mergeTreeClean).toBe(false);
    expect(evidence.record.decision.outcome).toBe("gate");
  });

  it("gates a resolver that is not the dispatched reviewer", async () => {
    const evidence = await collect(world(), { resolver: { agentId: "agent-other", sessionId: REVIEWER.sessionId } });

    expect(evidence.record.decision.reason).toContain("resolver-is-dispatched-reviewer");
  });

  it("gates a truncated file list instead of deciding from part of the diff", async () => {
    const fake = world();
    fake.prChangedFiles.set(1, 5);

    const evidence = await collect(fake);

    expect(evidence.merge.changedPaths).toEqual([]);
    expect(evidence.record.decision.outcome).toBe("gate");
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A workflow that takes the MERGE review through the sh-merge-evidence step, then lands with the Shepherd options. */
function shepherdHost(fake: FakeGitHub, beforeLand: () => void = () => undefined): FactoryHost {
  const port = githubPort(fake.wire);
  let clock = 0;
  const deps: ShepherdDeps = { port, store: shepherdStoreRef(), now: () => clock, sleep: async (ms) => void (clock += ms), agentChatBin: "agent-chat" };
  const run = async (ctx: Parameters<typeof mergeVerdict>[0]) => {
    const reviews = new Map<string, Verdict>([[HEAD, await mergeVerdict(ctx, input)]]);
    beforeLand();
    await land(ctx, { repo: REPO, pr: 1 }, shepherdLandOptions(AUTO, (headSha) => reviews.get(headSha)));
  };
  const workflow = defineWorkflow({ name: "shepherd-merge", steps: [...LAND_STEPS, ...REVIEW_STEPS], run });
  const routes = [...landRoutes({ port, now: deps.now, sleep: deps.sleep }), ...reviewRoutes(deps)];
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

describe("approve-merge under merge:auto", () => {
  it("merges with one merge-policy record naming authority/MRG-AU-RV, the evidence record, no hitl row and one comment", async () => {
    const fake = world();
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    const host = shepherdHost(fake);

    const run = await host.runtime.wait(host.runtime.start("shepherd-merge"));
    const record = host.runtime.status(run.id)!.stepResults["merge-policy:0:0"]!.data;

    expect(run.status).toBe("completed");
    expect(fake.effects.merge).toBe(1);
    expect(host.gates.get(gateId(run.id, "approve-merge"))).toBeUndefined();
    expect(host.pendingGates()).toEqual([]);
    expect(record).toMatchObject({
      result: { outcome: "allow", headSha: HEAD, rule: { table: "authority", rowId: "MRG-AU-RV" } },
      allowEvidence: { runId: run.id, head: HEAD, reviewer: REVIEWER, decision: { outcome: "allow" } },
    });
    expect(fake.comments.get(1)).toHaveLength(1);
  });

  it("opens approve-merge and does not merge when the facts at the head gate", async () => {
    const fake = world();
    fake.setRuns(HEAD, [successRun("validate", 1, undefined, null as unknown as string), successRun("dag-check", 2)]);
    const host = shepherdHost(fake, () => (fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)])));
    const runId = host.runtime.start("shepherd-merge");

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(fake.effects.merge).toBe(0);
    expect(host.runtime.status(runId)!.stepResults["merge-policy:0:0"]!.data).not.toHaveProperty("allowEvidence");
    host.runtime.signal(runId, "approve-merge", { decision: "abandon", headSha: HEAD });
    await host.runtime.wait(runId);
  });
});
