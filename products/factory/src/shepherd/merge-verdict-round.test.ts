import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, outsideActions } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { evidenceMarker } from "./evidence-comment.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { mergeVerdict } from "./review.js";
import { MergeEvidenceSchema } from "./review-schemas.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };

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

/** A fake GitHub whose `validate` conclusion the test sets, counting the evidence comments posted at H1. */
function github(conclusion: () => string) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, conclusion()), successRun("dag-check", 2)].map((run) => (run.conclusion === "failure" ? outsideActions(run) : run)));
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const wire = githubPort(fake.wire);
  const posted = { evidence: 0 };
  const port: GitHubPort = {
    ...wire,
    upsertComment: async (repo, pr, marker, body) => ((posted.evidence += marker === evidenceMarker(H1) ? 1 : 0), wire.upsertComment(repo, pr, marker, body)),
    checkRuns: async (repo, sha) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("validate", 9), successRun("dag-check", 10)]), wire.checkRuns(repo, sha)),
  };
  return { port, posted };
}

/** A host over `port` and the run database at `dbPath`; reopening it on the same file replays the run from its records. */
function host(review: ShepherdPhases["review"], port: GitHubPort, dbPath: string): FactoryHost {
  let clock = 0;
  const routes = factoryRoutesFor({ port, store: shepherdStoreRef(), now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const opened = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow({ review, wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }) }), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(opened);
  return opened;
}

const validateConclusion = (verdict: Verdict): string | null | undefined =>
  verdict.kind === "MERGE" ? MergeEvidenceSchema.parse(verdict.evidence).record.checkRuns.find((run) => run.name === "validate")?.conclusion : undefined;

describe("mergeVerdict across review rounds at one head", () => {
  it("re-reads the evidence in a later round at the same head, while a replay of the first round reuses its record", async () => {
    let conclusion = "success";
    const seen: Verdict[] = [];
    const review: ShepherdPhases["review"] = async (ctx, request) => {
      const take = () => mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: [] });
      conclusion = "failure";
      seen.push(await take());
      conclusion = "success";
      seen.push(await take());
      return seen[seen.length - 1]!;
    };
    const { port, posted } = github(() => conclusion);
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp572-")), "factory.db");
    const first = host(review, port, dbPath);
    const runId = first.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    await gateOpened(first, gateId(runId, "approve-merge"));
    first.close();

    const second = host(review, port, dbPath);
    await second.runtime.hydrate();
    await gateOpened(second, gateId(runId, "approve-merge"));
    second.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await second.runtime.wait(runId);

    expect(seen).toHaveLength(4);
    expect(seen.slice(0, 2).map(validateConclusion)).toEqual(["failure", "success"]);
    expect(seen.slice(2)).toEqual(seen.slice(0, 2));
    expect(posted.evidence).toBe(2);
  });
});
