import { describe, expect, it } from "vitest";
import type { MergeFacts } from "./conditions.js";
import { isCarryFencedPath, unmetConditions } from "./conditions.js";
import { evaluate } from "./evaluate.js";
import { DEFAULT_TABLE } from "./table.js";

const FROM_HEAD = "b".repeat(40);
const HEAD = "a".repeat(40);
const TREE = "c".repeat(40);
const APP = 15368;
const REVIEWER = { agentId: "rv-1", sessionId: "session-1" };
const DISJOINT = "verdict-merge-carried-merge-up-disjoint";

/** A security PR's MERGE at FROM_HEAD carried to HEAD, a clean merge-up whose base side touched none of the PR's files. */
function disjointFacts(): MergeFacts {
  return {
    head: HEAD,
    resolver: { ...REVIEWER },
    dispatchedReviewer: { ...REVIEWER },
    verdict: { value: "MERGE", head: FROM_HEAD },
    requiredContexts: ["check"],
    allowedApps: [APP],
    checkRuns: [{ name: "check", appId: APP, headSha: HEAD, conclusion: "success" }],
    mergeTreeClean: true,
    repoFrozen: false,
    changedPaths: ["src/a.ts", "src/b.ts"],
    seatGrants: ["merge-on-green-approve"],
    carry: { fromHead: FROM_HEAD, head: HEAD, headTree: TREE, mergeTree: TREE, rule: "merge-up-disjoint", basePaths: ["src/c.ts"], firstParent: FROM_HEAD },
    kind: "security",
  };
}

function decide(facts: MergeFacts) {
  const request = { action: "merge", actor: { class: "automation", id: "shepherd" }, tainted: false, subject: {}, facts: { merge: facts } } as const;
  return evaluate(DEFAULT_TABLE, request);
}

function patched(patch: (facts: MergeFacts) => void): MergeFacts {
  const facts = disjointFacts();
  patch(facts);
  return facts;
}

const row = (id: string) => DEFAULT_TABLE.rules.find((rule) => rule.id === id);

describe("MRG-AU-RS: an automation merge on a verdict carried across a merge-up disjoint from the PR's files", () => {
  it("allows a security PR's MERGE carried to a clean merge-up whose base side shares no path with the PR", () => {
    expect(decide(disjointFacts())).toEqual({ verdict: "allow", ruleId: "MRG-AU-RS" });
  });

  it("allows any kind, and an unregistered one, since disjointness rather than kind is the guard", () => {
    expect(decide(patched((f) => { f.kind = "unknown"; }))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RS" });
    expect(decide(patched((f) => { Reflect.deleteProperty(f, "kind"); }))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RS" });
  });

  it("keeps every MRG-AU-RC condition except the tree-equal carry and the kind", () => {
    const replaced = new Set(["verdict-merge-carried-tree-equal", "pr-kind-not-security"]);
    const expected = (row("MRG-AU-RC")?.when ?? []).filter((c) => !replaced.has(c));
    expect([...(row("MRG-AU-RS")?.when ?? [])].sort()).toEqual([...expected, DISJOINT].sort());
  });

  const REFUSALS: [string, (facts: MergeFacts) => void][] = [
    ["a base side that touches a PR path", (f) => { f.carry!.basePaths = ["src/c.ts", "src/a.ts"]; }],
    ["a base path that differs from a PR path only by case", (f) => { f.carry!.basePaths = ["SRC/A.ts"]; }],
    ["a renamed-away path on the base side that the PR also touches", (f) => { f.carry!.basePaths = ["src/old.ts", "src/b.ts"]; }],
    ["an empty changed-path list", (f) => { f.changedPaths = []; }],
    ["a missing base-path list", (f) => { Reflect.deleteProperty(f.carry!, "basePaths"); }],
    ["a non-canonical base path", (f) => { f.carry!.basePaths = ["src/./a.ts"]; }],
    ["a non-canonical PR path", (f) => { f.changedPaths = ["src/a.ts", "src/c.ts "]; }],
    ["a head tree that is not the merge tree", (f) => { f.carry!.mergeTree = "d".repeat(40); }],
    ["a tree-equal rule", (f) => { f.carry!.rule = "tree-equal"; }],
    ["a remerge rule", (f) => { f.carry!.rule = "remerge-empty"; }],
    ["a carry with no rule", (f) => { Reflect.deleteProperty(f.carry!, "rule"); }],
    ["a carry for a different head", (f) => { f.carry!.head = "e".repeat(40); }],
    ["a carry from a head the verdict does not name", (f) => { f.carry!.fromHead = "e".repeat(40); }],
    ["a short from-head", (f) => { f.carry!.fromHead = "b".repeat(12); f.verdict.head = "b".repeat(12); }],
    ["a FIX_FIRST verdict", (f) => { f.verdict.value = "FIX_FIRST"; }],
    ["a base side that touches packages/authority/", (f) => { f.carry!.basePaths = ["src/c.ts", "packages/authority/src/table.json"]; }],
    ["a base side that touches packages/tool-guard/", (f) => { f.carry!.basePaths = ["packages/tool-guard/src/guard.ts"]; }],
    ["a base side that touches .github/workflows/", (f) => { f.carry!.basePaths = [".github/workflows/ci.yml"]; }],
    ["a fenced base path that differs only by case", (f) => { f.carry!.basePaths = [".GitHub/Workflows/release.yml"]; }],
    ["a fenced base path on an unknown kind", (f) => { f.kind = "unknown"; f.carry!.basePaths = ["packages/authority/src/conditions.ts"]; }],
    ["a fenced base path on an unregistered kind", (f) => { Reflect.deleteProperty(f, "kind"); f.carry!.basePaths = ["packages/tool-guard/src/guard.ts"]; }],
  ];

  it.each(REFUSALS)("falls back to the owner gate on %s", (_name, patch) => {
    const facts = patched(patch);
    expect(unmetConditions([DISJOINT], { merge: facts })).toEqual([DISJOINT]);
    expect(decide(facts)).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it("allows a base side under sibling prefixes of the fenced directories", () => {
    const facts = patched((f) => { f.carry!.basePaths = ["packages/authority-tools/a.ts", "packages/tool-guardian/b.ts", ".github/workflows-old.md"]; });
    expect(decide(facts)).toEqual({ verdict: "allow", ruleId: "MRG-AU-RS" });
  });

  it("leaves a non-security carry across a fenced base side to MRG-AU-RC, since the carve-out covers MRG-AU-RS only", () => {
    const facts = patched((f) => { f.kind = "correctness"; f.carry!.basePaths = ["packages/authority/src/table.json"]; });
    expect(decide(facts)).toEqual({ verdict: "allow", ruleId: "MRG-AU-RC" });
  });

  it("leaves a security tree-equal carry to the owner gate, matching neither MRG-AU-RC nor MRG-AU-RS", () => {
    const facts = patched((f) => { f.carry = { fromHead: FROM_HEAD, head: HEAD, headTree: TREE, mergeTree: TREE, rule: "tree-equal" }; });
    expect(decide(facts)).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it("leaves a non-security disjoint carry, whose trees are equal, to MRG-AU-RC first", () => {
    expect(decide(patched((f) => { f.kind = "correctness"; }))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RC" });
  });
});

describe("isCarryFencedPath", () => {
  it.each(["packages/authority/src/table.json", "packages/tool-guard/src/guard.ts", ".github/workflows/ci.yml", "Packages/Authority/x.ts"])("fences %s", (path) => {
    expect(isCarryFencedPath(path)).toBe(true);
  });

  it.each([42, undefined, "packages/authority/../x", "packages/./authority/x", "src/a.ts\\b"])("fails closed on %s", (path) => {
    expect(isCarryFencedPath(path)).toBe(true);
  });

  it.each(["src/a.ts", "packages/authority-tools/a.ts", ".github/workflows-old.md"])("leaves %s unfenced", (path) => {
    expect(isCarryFencedPath(path)).toBe(false);
  });
});
