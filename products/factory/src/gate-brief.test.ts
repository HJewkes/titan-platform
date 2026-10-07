import { snapshotBrief } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { approveMergeDecision, ciEvidence, ciFailedDecision, conflictDecision, frozenDecision, mainEvidence, oneLine, prEvidence, sentBackDecision, stuckBehindDecision, verdictIsMergeAt } from "./gate-brief.js";

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
