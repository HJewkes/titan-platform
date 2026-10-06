import { describe, expect, it } from "vitest";
import { MAX_OWNER_BRIEF_CHARS, MergeEvidenceSchema, parseOwnerBrief, readMalformed } from "./review-schemas.js";

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

const VERDICT = `Looked at it.\n\nVerdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}\n`;
const BRIEF = [
  "OWNER-BRIEF",
  "What: Adds a retry to the widget sync.",
  "Why: It changes how every widget is synced.",
  "Pros:",
  "- Fewer dropped syncs.",
  "Cons:",
  "- Unreviewed timing change.",
  "- Slower failure reports.",
  "Door: one-way",
  "END-OWNER-BRIEF",
].join("\n");

describe("parseOwnerBrief", () => {
  it("reads the fields of a block that follows the verdict", () => {
    expect(parseOwnerBrief(`${VERDICT}\n${BRIEF}\n`)).toEqual({
      what: "Adds a retry to the widget sync.",
      why: "It changes how every widget is synced.",
      pros: ["Fewer dropped syncs."],
      cons: ["Unreviewed timing change.", "Slower failure reports."],
      doorType: "one-way",
    });
  });

  it("is null when the reviewer wrote no block", () => {
    expect(parseOwnerBrief(VERDICT)).toBeNull();
  });

  it("is null when the block comes before the verdict", () => {
    expect(parseOwnerBrief(`${BRIEF}\n${VERDICT}`)).toBeNull();
  });

  it.each([
    ["a door type that is neither", BRIEF.replace("one-way", "maybe")],
    ["no cons", BRIEF.replace(/Cons:[\s\S]*Door/, "Door")],
    ["a line that fits no field", BRIEF.replace("Door: one-way", "Door: one-way\nStray words")],
    ["a repeated field", BRIEF.replace("Door: one-way", "Door: one-way\nDoor: two-way")],
    ["two blocks", `${BRIEF}\n${BRIEF}`],
    ["a block over the length bound", BRIEF.replace("Adds a retry", "x".repeat(MAX_OWNER_BRIEF_CHARS))],
  ])("is null for %s", (_scenario, block) => {
    expect(parseOwnerBrief(`${VERDICT}\n${block}\n`)).toBeNull();
  });
});

describe("readMalformed", () => {
  it("reads the record from a stored none output", () => {
    expect(readMalformed({ kind: "none", malformed: { refusal: "bad_head", writtenAt: 12 }, extra: 1 })).toEqual({ refusal: "bad_head", writtenAt: 12 });
  });

  it.each([
    ["an output without the record", { kind: "none" }],
    ["a verdict output", { kind: "verdict", malformed: { refusal: "bad_head", writtenAt: 12 } }],
    ["an unknown refusal", { kind: "none", malformed: { refusal: "constructor", writtenAt: 12 } }],
    ["a non-numeric time", { kind: "none", malformed: { refusal: "bad_head", writtenAt: "12" } }],
    ["a non-object", "none"],
    ["null", null],
  ])("is null for %s", (_scenario, output) => {
    expect(readMalformed(output)).toBeNull();
  });
});
