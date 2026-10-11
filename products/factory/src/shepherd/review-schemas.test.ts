import { describe, expect, it } from "vitest";
import { MergeEvidenceSchema } from "./review-schemas.js";

const HEAD = "a".repeat(40);
const reviewer = { agentId: "agent-rv", sessionId: "session-1" };

const evidence = () => ({
  head: HEAD,
  merge: {
    head: HEAD,
    resolver: reviewer,
    dispatchedReviewer: reviewer,
    verdict: { value: "MERGE", head: HEAD },
    requiredContexts: ["validate"],
    allowedApps: [15368],
    checkRuns: [{ name: "validate", appId: 15368, headSha: HEAD, conclusion: "success" }],
    mergeTreeClean: true,
    repoFrozen: false,
    changedPaths: ["src/a.ts"],
    seatGrants: [],
  },
  record: {
    runId: "run-1",
    repo: "octo/demo",
    pr: 7,
    head: HEAD,
    baseRef: "main",
    testMergeSha: null,
    checkRuns: [{ name: "validate", id: 1, appId: 15368, conclusion: "success" }],
    verdictLocator: { sourceId: "transcript-1" },
    reviewer,
    decision: { outcome: "allow", rule: { table: "t", rowId: "r", version: 1 }, reason: "ok" },
  },
});

describe("MergeEvidenceSchema", () => {
  it("accepts evidence of the real shape", () => {
    expect(MergeEvidenceSchema.safeParse(evidence()).success).toBe(true);
  });

  it("rejects evidence whose merge facts are missing", () => {
    const rest: Partial<ReturnType<typeof evidence>> = evidence();
    delete rest.merge;

    expect(MergeEvidenceSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects evidence whose resolver names no session", () => {
    const bad = evidence();
    bad.merge.resolver = { agentId: "agent-rv" } as typeof reviewer;

    expect(MergeEvidenceSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects evidence whose verdict locator is not an object", () => {
    const bad = { ...evidence(), record: { ...evidence().record, verdictLocator: "transcript-1" } };

    expect(MergeEvidenceSchema.safeParse(bad).success).toBe(false);
  });
});
