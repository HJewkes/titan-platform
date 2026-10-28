import { describe, expect, it } from "vitest";
import { ciPolicyChanges } from "./ci-policy-changes.js";
import { ciPolicyInScope, planHonour, type CiPolicyFacts } from "./plan-approval-cover.js";
import type { PlanApprovalScope } from "./plan-approval.js";

const LINT = ".github/merge-lint.json";
const CI = ".github/workflows/ci.yml";
const SCOPE: PlanApprovalScope = { paths: [LINT], ciPolicyKeys: ["other"], entries: ['+    "entry-b"'] };
const APPENDED = ciPolicyChanges([{ path: LINT, before: '{\n  "allow": [\n    "entry-a"\n  ]\n}\n', after: '{\n  "allow": [\n    "entry-a",\n    "entry-b"\n  ]\n}\n' }]);
const FACTS: CiPolicyFacts = { keys: ["other"], githubPaths: [LINT], changes: APPENDED, unreadFacts: undefined };

const WORKFLOW_BEFORE = "jobs:\n  lint:\n    continue-on-error: true\n    steps:\n      - run: lint\n  test:\n    steps:\n      - run: test\n";
const RUN_APPROVED: PlanApprovalScope = { paths: [CI], ciPolicyKeys: ["required-check"], entries: ["+      - run: echo approved"] };
const workflowFacts = (files: { path: string; before: string; after: string }[]): CiPolicyFacts => ({ keys: ["required-check"], githubPaths: files.map((file) => file.path), changes: ciPolicyChanges(files), unreadFacts: undefined });

describe("a weakened CI-policy line against a plan approval", () => {
  it("is in scope when the only change past a same-position trailing comma is the approved entry", () => {
    expect(ciPolicyInScope(FACTS)(SCOPE)).toBe(true);
  });

  it("is out of scope when the approved entry was a removal of the same text", () => {
    expect(ciPolicyInScope(FACTS)({ ...SCOPE, entries: ['-    "entry-b"'] })).toBe(false);
  });

  it("is out of scope when the approved entry lacks the line's indentation", () => {
    expect(ciPolicyInScope(FACTS)({ ...SCOPE, entries: ['+"entry-b"'] })).toBe(false);
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

  it("is out of scope when an unapproved line moved to another job beside the approved one", () => {
    const after = "jobs:\n  lint:\n    steps:\n      - run: lint\n  test:\n    continue-on-error: true\n    steps:\n      - run: test\n      - run: echo approved\n";

    expect(ciPolicyInScope(workflowFacts([{ path: CI, before: WORKFLOW_BEFORE, after }]))(RUN_APPROVED)).toBe(false);
  });

  it("is out of scope when a line was only re-indented to another level", () => {
    const before = "permissions: {}\njobs:\n  release:\n    permissions:\n      contents: write\n";
    const after = "permissions:\n  contents: write\njobs:\n  release:\n    permissions:\n      contents: read\n";
    const facts = { ...workflowFacts([{ path: CI, before, after }]), keys: ["permissions" as const] };

    expect(ciPolicyInScope(facts)({ paths: [CI], ciPolicyKeys: ["permissions"], entries: ["-permissions: {}", "+permissions:", "-      contents: write", "+      contents: read"] })).toBe(false);
  });

  it("is out of scope when a line moved from one approved file to another", () => {
    const other = ".github/workflows/release.yml";
    const files = [
      { path: CI, before: "permissions: read-all\n", after: "" },
      { path: other, before: "", after: "permissions: read-all\n" },
    ];

    expect(ciPolicyInScope(workflowFacts(files))({ paths: [CI, other], ciPolicyKeys: ["required-check"], entries: [] })).toBe(false);
  });

  it("is out of scope when a changed line was cut at the card's width, whatever the entry says", () => {
    const long = `      - run: ${"x".repeat(200)}`;
    const facts = workflowFacts([{ path: CI, before: "", after: `${long}\n` }]);
    const shown = ciPolicyChanges([{ path: CI, before: "", after: `${long}\n` }])[0]!.lines[0]!.text;

    expect(ciPolicyInScope(facts)({ ...RUN_APPROVED, entries: [`+${shown}`, `+${long}`] })).toBe(false);
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
