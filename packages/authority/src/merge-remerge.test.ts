import { describe, expect, it } from "vitest";
import type { MergeFacts } from "./conditions.js";
import { unmetConditions } from "./conditions.js";
import { evaluate } from "./evaluate.js";
import { DEFAULT_TABLE } from "./table.js";

const FROM_HEAD = "b".repeat(40);
const HEAD = "a".repeat(40);
const HEAD_TREE = "c".repeat(40);
const REMERGE_TREE = "d".repeat(40);
const APP = 15368;
const REVIEWER = { agentId: "rv-1", sessionId: "session-1" };
const REMERGE = "verdict-merge-carried-remerge-clean";

/** A MERGE at FROM_HEAD carried to HEAD, a merge of the base whose remerge-diff touched only a generated file. */
function remergedFacts(): MergeFacts {
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
    changedPaths: ["packages/x/src/a.ts", "CAPABILITIES.md"],
    seatGrants: ["merge-on-green-approve"],
    carry: { fromHead: FROM_HEAD, head: HEAD, headTree: HEAD_TREE, mergeTree: REMERGE_TREE, rule: "remerge-generated-only", remergePaths: ["CAPABILITIES.md"], generatedPaths: ["CAPABILITIES.md"] },
    kind: "refactor",
  };
}

function decide(facts: MergeFacts) {
  const request = { action: "merge", actor: { class: "automation", id: "shepherd" }, tainted: false, subject: {}, facts: { merge: facts } } as const;
  return evaluate(DEFAULT_TABLE, request);
}

function patched(patch: (facts: MergeFacts) => void): MergeFacts {
  const facts = remergedFacts();
  patch(facts);
  return facts;
}

const row = (id: string) => DEFAULT_TABLE.rules.find((rule) => rule.id === id);

describe("MRG-AU-RM: an automation merge on a verdict carried across a merge that resolved nothing", () => {
  it("allows a MERGE carried to a head whose remerge-diff touches only declared generated files", () => {
    expect(decide(remergedFacts())).toEqual({ verdict: "allow", ruleId: "MRG-AU-RM" });
  });

  it("holds for an empty remerge-diff, whose trees are equal, so either carry row allows it", () => {
    const facts = patched((f) => { Object.assign(f.carry!, { rule: "remerge-empty", remergePaths: [], generatedPaths: [], mergeTree: HEAD_TREE }); });
    expect(unmetConditions([REMERGE], { merge: facts })).toEqual([]);
    expect(decide(facts)).toMatchObject({ verdict: "allow" });
  });

  it("keeps every MRG-AU-RC condition except the tree-equal one", () => {
    const expected = (row("MRG-AU-RC")?.when ?? []).filter((c) => c !== "verdict-merge-carried-tree-equal");
    expect([...(row("MRG-AU-RM")?.when ?? [])].sort()).toEqual([...expected, REMERGE].sort());
  });

  it("leaves a tree-equal carry to MRG-AU-RC", () => {
    const facts = patched((f) => { f.carry = { fromHead: FROM_HEAD, head: HEAD, headTree: HEAD_TREE, mergeTree: HEAD_TREE }; });
    expect(decide(facts)).toEqual({ verdict: "allow", ruleId: "MRG-AU-RC" });
  });

  const REFUSALS: [string, (facts: MergeFacts) => void, string?][] = [
    ["a remerge path that is not generated", (f) => { f.carry!.remergePaths = ["CAPABILITIES.md", "src/a.ts"]; }],
    ["a generated-only rule that touched nothing", (f) => { f.carry!.remergePaths = []; }],
    ["an empty rule whose trees differ", (f) => { Object.assign(f.carry!, { rule: "remerge-empty", remergePaths: [] }); }],
    ["an empty rule that touched a path", (f) => { f.carry!.rule = "remerge-empty"; }],
    ["a protected path declared generated", (f) => { Object.assign(f.carry!, { remergePaths: ["CODEOWNERS"], generatedPaths: ["CODEOWNERS"] }); }],
    ["a carry with no rule", (f) => { Reflect.deleteProperty(f.carry!, "rule"); }],
    ["a tree-equal rule", (f) => { f.carry!.rule = "tree-equal"; }],
    ["a missing path list", (f) => { Reflect.deleteProperty(f.carry!, "generatedPaths"); }],
    ["a carry for a different head", (f) => { f.carry!.head = "e".repeat(40); }],
    ["a carry from a head the verdict does not name", (f) => { f.carry!.fromHead = "e".repeat(40); }],
    ["a FIX_FIRST verdict", (f) => { f.verdict.value = "FIX_FIRST"; }],
    ["a security kind", (f) => { f.kind = "security"; }, "pr-kind-not-security"],
  ];

  it.each(REFUSALS)("falls back to the owner gate on %s", (_name, patch, condition = REMERGE) => {
    const facts = patched(patch);
    expect(unmetConditions([condition as "pr-kind-not-security"], { merge: facts })).toEqual([condition]);
    expect(decide(facts)).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });
});
