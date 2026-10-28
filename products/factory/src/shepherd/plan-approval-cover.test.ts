import { describe, expect, it } from "vitest";
import { ciPolicyInScope, planHonour, type CiPolicyFacts } from "./plan-approval-cover.js";
import type { PlanApprovalScope } from "./plan-approval.js";

const LINT = ".github/merge-lint.json";
const SCOPE: PlanApprovalScope = { paths: [LINT], ciPolicyKeys: ["other"], entries: ['+"entry-b"'] };
const APPENDED = [{ path: LINT, omitted: 0, lines: [{ side: "-", n: 3, text: '    "entry-a"' }, { side: "+", n: 3, text: '    "entry-a",' }, { side: "+", n: 4, text: '    "entry-b"' }] }];
const FACTS: CiPolicyFacts = { keys: ["other"], githubPaths: [LINT], changes: APPENDED, unreadFacts: undefined };

describe("a weakened CI-policy line against a plan approval", () => {
  it("is in scope when the only change past a trailing comma is the approved entry", () => {
    expect(ciPolicyInScope(FACTS)(SCOPE)).toBe(true);
  });

  it("is out of scope when the approved entry was a removal of the same text", () => {
    expect(ciPolicyInScope(FACTS)({ ...SCOPE, entries: ['-"entry-b"'] })).toBe(false);
  });

  it("is out of scope when a key the reviewer named is not approved", () => {
    expect(ciPolicyInScope({ ...FACTS, keys: ["other", "permissions"] })(SCOPE)).toBe(false);
  });

  it("is out of scope when the card cap left a line out or a file read closed", () => {
    expect(ciPolicyInScope({ ...FACTS, changes: [{ ...APPENDED[0], omitted: 1 }] })(SCOPE)).toBe(false);
    expect(ciPolicyInScope({ ...FACTS, unreadFacts: ["the CI-policy lines of x are unreadable"] })(SCOPE)).toBe(false);
  });

  it("is out of scope when the changed lines were never read", () => {
    expect(ciPolicyInScope({ ...FACTS, changes: undefined })(SCOPE)).toBe(false);
  });
});

describe("the plan honour of one decision", () => {
  it("names the round of the approval that covered a row, and nothing when none did", () => {
    const honour = planHonour([{ gate: "skill", scope: { paths: ["a"] }, round: "r-7" }]);

    expect(honour.covers("visual", () => true)).toBe(false);
    expect(honour.note()).toBe("");
    expect(honour.covers("skill", () => true)).toBe(true);
    expect(honour.note()).toBe("; approved at plan round r-7");
  });
});
