import { fakeGitHub, fakeSha, githubPort, successRun, type GitHubPort } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { fakeLocator } from "../test-support/fakes.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { evidenceComment, evidenceMarker } from "./evidence-comment.js";
import type { EvidenceRecord } from "./evidence-record.js";
import { markMerged } from "./evidence-merged.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const SEAT = "demo-seat";
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", seat: SEAT };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const EARLIER = fakeSha("earlier");
const MERGE_SHA = fakeSha("merged-commit");

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const phases: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: (ctx, request: ReviewRequest) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator: partialFake({}) }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }),
};

function world() {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    pr.mergeableState = "clean";
  };
  const port = githubPort(fake.wire);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port, store, now: () => 0, sleep: async () => undefined, park: async () => ({ lines: [] }), registry: async () => "trusted" as const, mergeTree: async () => "clean" });
  fake.addPr({ headSha: H1, mergeSha: MERGE_SHA });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return { fake, host, store };
}

const bodies = (fake: ReturnType<typeof fakeGitHub>): string[] => (fake.comments.get(1) ?? []).map((comment) => comment.body);
const bodyAt = (fake: ReturnType<typeof fakeGitHub>, head: string): string | undefined => bodies(fake).find((body) => body.startsWith(evidenceMarker(head)));

describe("sh-evidence-merged after a Shepherd merge", () => {
  it("adds the Merged line to the merged head's comment and leaves an earlier head's comment alone", async () => {
    const w = world();
    const earlier = `${evidenceMarker(EARLIER)}\nShepherd cleared to merge at an earlier head`;
    w.fake.comments.set(1, [{ id: 900, body: earlier, author: w.fake.actor }]);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
    w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/T-1", implementer: "impl-1", policy: AUTO });

    await w.host.runtime.wait(runId);

    expect(w.fake.pr(1).merged).toBe(true);
    expect(bodyAt(w.fake, H1)).toContain(`**Merged** at \`${MERGE_SHA.slice(0, 7)}\`.`);
    expect(bodyAt(w.fake, H1)).toContain("cleared to merge");
    expect(bodyAt(w.fake, EARLIER)).toBe(earlier);
    expect(w.host.runtime.status(runId)!.status).not.toBe("failed");
    const order = Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
    expect(order.indexOf("sh-evidence-merged")).toBeGreaterThan(order.indexOf("sh-landed"));
  }, 20_000);

  it("never says merged in the evidence comment while the PR is still open", async () => {
    const w = world();
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/T-1", implementer: "impl-1", policy: OWNER_GATE_POLICY });

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(w.fake.pr(1).merged).toBe(false);
    expect(bodies(w.fake).filter((body) => body.startsWith("<!-- shepherd-evidence:")).join("\n")).not.toMatch(/\bmerged\b/i);
  }, 20_000);
});

describe("markMerged", () => {
  const record: EvidenceRecord = {
    runId: "run-1",
    repo: REPO,
    pr: 1,
    head: H1,
    baseRef: "main",
    testMergeSha: null,
    checkRuns: [{ name: "validate", id: 1, appId: 15368, conclusion: "success" }],
    verdictLocator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }),
    reviewer,
    decision: { outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV", version: 1 }, reason: "synthetic" },
    mergeableState: "clean",
  };
  const input = { repo: REPO, pr: 1, headSha: H1, record };

  function posted(merge: { merged?: boolean; state?: "open" | "closed"; headSha?: string } = {}) {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1, mergeSha: MERGE_SHA, ...merge });
    fake.comments.set(1, [{ id: 1, body: evidenceComment(record), author: fake.actor }]);
    return { fake, port: githubPort(fake.wire) };
  }
  const merged = { merged: true, state: "closed" as const };

  it("edits the comment once GitHub reports the same head merged", async () => {
    const { fake, port } = posted(merged);

    const result = await markMerged(port, input);

    expect(result).toMatchObject({ edited: true });
    expect(bodies(fake)).toHaveLength(1);
    expect(bodies(fake)[0]).toContain(`**Merged** at \`${MERGE_SHA.slice(0, 7)}\``);
  });

  it("leaves the comment unchanged when the PR is open", async () => {
    const { fake, port } = posted();

    const result = await markMerged(port, input);

    expect(result).toMatchObject({ edited: false });
    expect(bodies(fake)).toEqual([evidenceComment(record)]);
  });

  it("leaves the comment unchanged when the merged PR's head is another head", async () => {
    const { fake, port } = posted({ ...merged, headSha: fakeSha("other") });

    const result = await markMerged(port, input);

    expect(result).toMatchObject({ edited: false, reason: "head-differs" });
    expect(bodies(fake)).toEqual([evidenceComment(record)]);
  });

  it("leaves the comment unchanged and does not throw when getPr fails", async () => {
    const { fake, port } = posted(merged);
    const failing: GitHubPort = { ...port, getPr: async () => Promise.reject(new TypeError("synthetic read failure")) };

    const result = await markMerged(failing, input);

    expect(result).toEqual({ edited: false, reason: "TypeError" });
    expect(bodies(fake)).toEqual([evidenceComment(record)]);
  });

  it("does not edit when the record is for a different head", async () => {
    const { fake, port } = posted(merged);

    const result = await markMerged(port, { ...input, record: { ...record, head: EARLIER } });

    expect(result).toMatchObject({ edited: false });
    expect(bodies(fake)).toEqual([evidenceComment(record)]);
  });
});
