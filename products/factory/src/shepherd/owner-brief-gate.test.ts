import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { OwnerBrief } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import type { ShepherdPhases } from "./phases.js";
import type { EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const VISUAL_AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: false, seat: "design-seat", visualPaths: ["packages/ui/**"] };
const BRIEF: OwnerBrief = { what: "Restyle the primary button", why: "The old focus ring failed contrast", pros: ["Passes contrast checks"], cons: ["Every screenshot baseline moves"], doorType: "two-way" };

const locator: SourceTextLocator = {
  source: {
    sourceId: "transcript-1",
    harness: "claude-code",
    format: "jsonl",
    formatVersion: null,
    path: "/transcripts/transcript-1.jsonl",
    namespace: "test",
    conversation: { harness: "claude-code", namespace: "test", nativeId: "session-rv-1" },
    provenance: { kind: "native", name: "test" },
  },
  evidence: {
    line: { sourceId: "transcript-1", byteOffset: 0, byteLength: 1, contentHash: "0".repeat(64), lineNumber: 1, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
};

/** A shepherd run over green CI and a changed visual file, whose reviewer says MERGE with `ownerBrief`. */
async function visualGate(ownerBrief: OwnerBrief | undefined) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "packages/ui/src/x.tsx", status: "modified" }]);
  const review: ShepherdPhases["review"] = (ctx, request) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: [] }, ownerBrief);
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: shepherdStoreRef(), now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review, wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }) }), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(VISUAL_AUTO) });
  await gateOpened(host, gateId(runId, "approve-merge"));
  return host.gates.get(gateId(runId, "approve-merge"))!;
}

describe("the approve-merge gate a visual-path change opens on an auto run", () => {
  it("carries the reviewer's owner brief in its prompt and in the question the owner reads", async () => {
    const gate = await visualGate(BRIEF);

    expect(gate.prompt).toContain("visual-path");
    expect(gate.prompt).toContain(`What: ${BRIEF.what}`);
    expect(gate.prompt).toContain(`- ${BRIEF.pros[0]}`);
    expect(gate.prompt).toContain("Door: two-way");
    expect(gate.questions?.[0]?.question).toContain(BRIEF.what);
    expect(gate.questions?.[0]?.question).toContain(BRIEF.cons[0]);
  });

  it("asks without an owner-brief block when the reviewer wrote none", async () => {
    const gate = await visualGate(undefined);

    expect(gate.prompt).toContain("visual-path");
    expect(gate.prompt).not.toContain("owner brief");
    expect(gate.questions?.[0]?.question).toBe(`Land ${H1}?`);
  });
});
