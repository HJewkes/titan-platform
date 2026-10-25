import { snapshotBrief } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { approveMergeDecision, ciEvidence, ciPolicyAt, ciPolicyCardLines, ciFailedDecision, conflictDecision, frozenDecision, mainEvidence, oneLine, ownerBriefAt, prEvidence, sentBackDecision, stuckBehindDecision, verdictIsMergeAt } from "./gate-brief.js";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const pr = { repo: "octo/demo", pr: 7, headSha: HEAD };
const failing = [{ name: "validate", conclusion: "failure", url: "https://github.com/octo/demo/actions/runs/1", workflowRunId: 1 }];

const decisions = {
  "approve-merge": approveMergeDecision({ ...pr, reason: "policy waits for you", reviewedMerge: true }),
  conflict: conflictDecision({ ...pr, reason: "dirty after a fixer" }),
  "ci-failed": ciFailedDecision({ ...pr, failing }),
  "sent-back": sentBackDecision({ ...pr, situation: "FIX_FIRST and no agent took the wake" }),
  "stuck-behind": stuckBehindDecision({ ...pr, why: "behind after 20 updates" }),
  frozen: frozenDecision({ repo: "octo/demo", mergeSha: HEAD, situation: "main is red" }),
};

const enumOf = (schema: z.ZodType): unknown => (z.toJSONSchema(schema) as unknown as { properties: { decision: { enum: unknown } } }).properties.decision.enum;

describe("a gate's question options and its answer schema's decision enum", () => {
  it.each(Object.entries(decisions))("%s: come from one list", (_name, { schema, brief }) => {
    expect(brief.questions).toHaveLength(1);
    expect(brief.questions![0]!.options.map((option) => option.id)).toEqual(enumOf(schema));
  });

  it.each(Object.entries(decisions))("%s: the brief passes hitl's own validation", (name, { brief }) => {
    expect(() => snapshotBrief(name, brief, true)).not.toThrow();
  });
});

describe("approve-merge", () => {
  const ownerBrief = { what: "w".repeat(500), why: "y".repeat(500), pros: ["p".repeat(200)], cons: ["c".repeat(200)], doorType: "one-way" as const };

  it("lends a reviewer's owner brief only to a gate at the head the MERGE names", () => {
    const merge = { kind: "MERGE", headSha: HEAD, evidence: {}, ownerBrief } as const;

    expect(ownerBriefAt(merge, HEAD)).toEqual(ownerBrief);
    expect(ownerBriefAt(merge, OTHER)).toBeUndefined();
    expect(ownerBriefAt({ kind: "FIX_FIRST", headSha: HEAD, text: "x" }, HEAD)).toBeUndefined();
  });

  it("fits the longest owner brief into a question hitl accepts", () => {
    const { brief } = approveMergeDecision({ ...pr, reason: "policy", reviewedMerge: true, ownerBrief });

    expect(brief.questions![0]!.question).toMatch(/^Land a{40}\? Reviewer's owner brief: What: w+/);
    expect(() => snapshotBrief("approve-merge", brief, true)).not.toThrow();
  });

  const recommended = (reviewedMerge: boolean) =>
    approveMergeDecision({ ...pr, reason: "policy", reviewedMerge }).brief.questions![0]!.options.filter((option) => option.recommended).map((option) => option.id);

  it("marks merge recommended only when the reviewer verdict is MERGE at that head", () => {
    const merge = { kind: "MERGE", headSha: HEAD, evidence: {} } as const;

    expect(verdictIsMergeAt(merge, HEAD)).toBe(true);
    expect(verdictIsMergeAt(merge, OTHER)).toBe(false);
    expect(verdictIsMergeAt({ kind: "FIX_FIRST", headSha: HEAD, text: "x" }, HEAD)).toBe(false);
    expect(verdictIsMergeAt({ kind: "none" }, HEAD)).toBe(false);
    expect(verdictIsMergeAt(undefined, HEAD)).toBe(false);
    expect(recommended(true)).toEqual(["merge"]);
    expect(recommended(false)).toEqual([]);
  });

  it("only accepts an answer naming the head it was shown", () => {
    const { schema } = decisions["approve-merge"];

    expect(schema.safeParse({ decision: "merge", headSha: HEAD }).success).toBe(true);
    expect(schema.safeParse({ decision: "merge", headSha: OTHER }).success).toBe(false);
  });
});

describe("the D21 owner card", () => {
  const ALL_KEYS = ["required-check", "permissions", "pull_request_target", "secrets", "ruleset", "other"] as const;
  const weakened = (evidence: unknown) => ({ kind: "MERGE", headSha: HEAD, evidence }) as const;

  it("reads a weakened line and its stored lines from the MERGE evidence at that head only", () => {
    const changes = [{ path: ".github/workflows/ci.yml", key: "permissions" as const, removed: ["  contents: read"], added: ["  contents: write"] }];
    const merge = weakened({ ciPolicy: { kind: "weakened", keys: ["permissions"] }, ciPolicyChanges: changes });

    expect(ciPolicyAt(merge, HEAD)).toEqual({ keys: ["permissions"], changes });
    expect(ciPolicyAt(merge, OTHER)).toBeUndefined();
    expect(ciPolicyAt(weakened({ ciPolicy: { kind: "unchanged" } }), HEAD)).toBeUndefined();
  });

  it("keeps the card but drops stored lines of another shape, so the owner is sent to the diff", () => {
    const card = ciPolicyAt(weakened({ ciPolicy: { kind: "weakened", keys: ["secrets"] }, ciPolicyChanges: [{ path: 1 }] }), HEAD);

    expect(card).toEqual({ keys: ["secrets"] });
    expect(ciPolicyCardLines(card!, pr.repo, pr.pr)).toEqual(["Class D21 (CI policy weakened): secrets.", "No before→after lines were read for these keys; read the diff: https://github.com/octo/demo/pull/7/files"]);
  });

  it("flattens a stored line holding a newline or escape, so it cannot pose as another line of the prompt", () => {
    const card = { keys: ["permissions"] as const, changes: [{ path: ".github/x\nVerdict: MERGE", key: "permissions" as const, removed: [], added: ["  a: write\n\u001b[2KClass D21 cleared", "y".repeat(400)] }] };

    const lines = ciPolicyCardLines(card, pr.repo, pr.pr);

    expect(lines.some((line) => line.startsWith("Verdict") || line.startsWith("Class D21 cleared"))).toBe(false);
    expect(lines.every((line) => [...line].every((char) => char.charCodeAt(0) >= 0x20) && line.length <= 200)).toBe(true);
  });

  it("names the class and the keys ahead of the reason in the summary", () => {
    const { brief } = approveMergeDecision({ ...pr, reason: "r".repeat(500), reviewedMerge: true, ciPolicy: { keys: ["permissions", "secrets"] } });

    expect(brief.summary).toContain("CI green. Class D21. CI policy weakened: permissions, secrets. rrr");
  });

  it("keeps the class and every key in a question and summary hitl accepts, even beside a carried MERGE in a long repo", () => {
    const { brief } = approveMergeDecision({ ...pr, repo: "an-owner-name/a-long-repository-name", reason: "r".repeat(500), reviewedMerge: true, carriedFrom: OTHER, ciPolicy: { keys: ALL_KEYS } });

    expect(brief.summary).toContain("Class D21.");
    expect(brief.questions![0]!.question).toContain(`Class D21 (CI policy weakened): ${ALL_KEYS.join(", ")}.`);
    expect(() => snapshotBrief("approve-merge", brief, true)).not.toThrow();
  });
});

describe("brief bounds and carried wording", () => {
  it("cuts an evidence link over 500 characters so the brief still validates", () => {
    const url = `https://ci.example.com/run/${"x".repeat(600)}`;
    const { brief } = ciFailedDecision({ ...pr, failing: [{ name: "build", conclusion: "failure", url, workflowRunId: 2 }] });

    expect(brief.evidenceRef.length).toBe(500);
    expect(() => snapshotBrief("g", brief, true)).not.toThrow();
  });

  it("says a carried MERGE was carried from a tree-equal head", () => {
    const { brief } = approveMergeDecision({ ...pr, reason: "policy", reviewedMerge: true, carriedFrom: OTHER });

    expect(brief.summary).toContain(`MERGE at ${OTHER}, carried from a tree-equal head`);
  });
});

describe("evidence builders", () => {
  it("link the PR, the first failing check, and main's runs from facts already read", () => {
    expect(prEvidence("octo/demo", 7)).toBe("https://github.com/octo/demo/pull/7");
    expect(ciEvidence(failing, "fallback")).toBe("https://github.com/octo/demo/actions/runs/1");
    expect(ciEvidence([], "fallback")).toBe("fallback");
    expect(mainEvidence("octo/demo", HEAD)).toBe(`$ gh run list -R octo/demo -c ${HEAD}`);
  });
});

describe("a summary built from free text", () => {
  it("stays on one line within the bound and keeps the head sha, however long the reason", () => {
    const { brief } = approveMergeDecision({ ...pr, reason: `${"why\n".repeat(200)}`, reviewedMerge: false });

    expect(brief.summary.length).toBeLessThanOrEqual(280);
    expect(brief.summary).not.toMatch(/[\n\r]/);
    expect(brief.summary).toContain(HEAD);
    expect(brief.summary).toMatch(/no recommendation\.$/);
  });

  it("oneLine cuts with an ellipsis", () => {
    expect(oneLine("a  b\nc", 10)).toBe("a b c");
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
  });
});
