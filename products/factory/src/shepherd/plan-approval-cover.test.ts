import { describe, expect, it } from "vitest";
import { ciPolicyCovers, planHonour, type CiPolicyFacts } from "./plan-approval-cover.js";
import type { CiPolicyScope, PlanApproval } from "./plan-approval.js";

const LINT = ".github/merge-lint.json";
const RENAMED_TO = ".github/workflows/new.yml";
const RENAMED_FROM = ".github/workflows/old.yml";
const LINT_BLOB = "1".repeat(40);
const NEW_BLOB = "2".repeat(40);
const SCOPE: CiPolicyScope = { ciPolicyKeys: ["other"], files: [{ path: LINT, blob: LINT_BLOB }] };
const FACTS: CiPolicyFacts = { keys: ["other"], changed: [LINT], headBlobs: { [LINT]: LINT_BLOB } };

describe("a CI-policy plan approval's cover", () => {
  it("covers a head whose every changed path is pinned to its blob there", () => {
    expect(ciPolicyCovers(SCOPE, FACTS)).toBe(true);
  });

  it("never covers a PR with no changed path", () => {
    expect(ciPolicyCovers(SCOPE, { ...FACTS, changed: [], headBlobs: {} })).toBe(false);
  });

  it("does not cover a weakened key the owner was not told about", () => {
    expect(ciPolicyCovers(SCOPE, { ...FACTS, keys: ["other", "required-check"] })).toBe(false);
  });

  it("does not cover a rename whose source is not pinned as absent", () => {
    const scope: CiPolicyScope = { ...SCOPE, files: [{ path: RENAMED_TO, blob: NEW_BLOB }] };
    const facts: CiPolicyFacts = { ...FACTS, changed: [RENAMED_TO, RENAMED_FROM], headBlobs: { [RENAMED_TO]: NEW_BLOB, [RENAMED_FROM]: null } };

    expect(ciPolicyCovers(scope, facts)).toBe(false);
    expect(ciPolicyCovers({ ...scope, files: [...scope.files, { path: RENAMED_FROM, blob: null }] }, facts)).toBe(true);
  });

  it("ignores a pinned path the PR leaves unchanged", () => {
    expect(ciPolicyCovers({ ...SCOPE, files: [...SCOPE.files, { path: RENAMED_TO, blob: NEW_BLOB }] }, FACTS)).toBe(true);
  });

  it("does not cover when the head blobs miss a changed path, even one pinned as absent", () => {
    const scope: CiPolicyScope = { ...SCOPE, files: [...SCOPE.files, { path: RENAMED_FROM, blob: null }] };

    expect(ciPolicyCovers(scope, { ...FACTS, changed: [LINT, RENAMED_FROM] })).toBe(false);
  });

  it("does not cover when the head blobs were never read or do not parse", () => {
    expect(ciPolicyCovers(SCOPE, { ...FACTS, headBlobs: undefined })).toBe(false);
    expect(ciPolicyCovers(SCOPE, { ...FACTS, headBlobs: { [LINT]: 7 } })).toBe(false);
  });
});

describe("honouring a run's claimed plan approvals", () => {
  const skill: PlanApproval = { gate: "skill", scope: { paths: ["a/SKILL.md"] }, round: "round-7" };

  it("names the round an allow rests on only once an approval covered a row", () => {
    const honour = planHonour([skill]);

    expect(honour.note()).toBe("");
    expect(honour.coversPaths("skill", ["a/SKILL.md"])).toBe(true);
    expect(honour.note()).toBe("; approved at plan round round-7");
  });

  it("marks a gating row unplanned only when the run holds an approval of that gate", () => {
    const honour = planHonour([skill]);

    expect(honour.coversPaths("skill", ["a/SKILL.md", "b/SKILL.md"])).toBe(false);
    expect(honour.unplanned("skill")).toContain("unplanned change");
    expect(honour.unplanned("visual")).toBe("");
  });

  it("never lets a skill approval cover a visual row", () => {
    expect(planHonour([skill]).coversPaths("visual", ["a/SKILL.md"])).toBe(false);
  });
});
