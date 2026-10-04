import { describe, expect, it } from "vitest";
import type { MergeFacts } from "./conditions.js";
import { unmetConditions } from "./conditions.js";
import { evaluate } from "./evaluate.js";
import { DEFAULT_TABLE } from "./table.js";

const FROM_HEAD = "b".repeat(40);
const HEAD = "a".repeat(40);
const TREE = "c".repeat(40);
const APP = 15368;
const REVIEWER = { agentId: "rv-1", sessionId: "session-1" };
const CARRIED = "verdict-merge-carried-tree-equal";

/** A MERGE at FROM_HEAD carried to HEAD by a tree-equal update. */
function carriedFacts(): MergeFacts {
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
    changedPaths: ["packages/x/src/a.ts"],
    seatGrants: ["merge-on-green-approve"],
    carry: { fromHead: FROM_HEAD, head: HEAD, headTree: TREE, mergeTree: TREE },
    kind: "correctness",
  };
}

function decide(facts: MergeFacts) {
  const request = { action: "merge", actor: { class: "automation", id: "shepherd" }, tainted: false, subject: {}, facts: { merge: facts } } as const;
  return evaluate(DEFAULT_TABLE, request);
}

function patched(patch: (facts: MergeFacts) => void): MergeFacts {
  const facts = carriedFacts();
  patch(facts);
  return facts;
}

function row(id: string) {
  return DEFAULT_TABLE.rules.find((rule) => rule.id === id);
}

describe("MRG-AU-RC: an automation merge on a carried verdict", () => {
  it("allows a MERGE at the reviewed head carried to a tree-equal head", () => {
    expect(decide(carriedFacts())).toEqual({ verdict: "allow", ruleId: "MRG-AU-RC" });
  });

  it("leaves MRG-AU-RV to decide a MERGE at the exact head, with or without a carry", () => {
    const exact = patched((f) => { f.verdict.head = HEAD; });
    const bare = patched((f) => { f.verdict.head = HEAD; Reflect.deleteProperty(f, "carry"); });
    expect(decide(exact)).toEqual({ verdict: "allow", ruleId: "MRG-AU-RV" });
    expect(decide(bare)).toEqual({ verdict: "allow", ruleId: "MRG-AU-RV" });
  });

  it("does not allow a carried verdict through MRG-AU-RV", () => {
    expect(decide(carriedFacts())).not.toMatchObject({ ruleId: "MRG-AU-RV" });
    expect(row("MRG-AU-RV")?.when).not.toContain(CARRIED);
    expect(row("MRG-AU-RV")?.when).toContain("verdict-merge-at-head");
  });

  it("keeps every MRG-AU-RV condition except verdict-merge-at-head", () => {
    const expected = (row("MRG-AU-RV")?.when ?? []).filter((c) => c !== "verdict-merge-at-head");
    expect([...(row("MRG-AU-RC")?.when ?? [])].sort()).toEqual([...expected, CARRIED, "pr-kind-not-security"].sort());
  });

  const REFUSALS: [string, (facts: MergeFacts) => void, string?][] = [
    ["a carry whose trees differ", (f) => { f.carry!.mergeTree = "d".repeat(40); }],
    ["a carry with an empty tree on both sides", (f) => { f.carry!.headTree = ""; f.carry!.mergeTree = ""; }],
    ["a carry for a different head", (f) => { f.carry!.head = "e".repeat(40); }],
    ["a carry from a head the verdict does not name", (f) => { f.carry!.fromHead = "e".repeat(40); }],
    ["a short sha for the head and the carry", (f) => { f.head = HEAD.slice(0, 7); f.carry!.head = HEAD.slice(0, 7); }],
    ["a short sha for the reviewed head", (f) => { f.verdict.head = FROM_HEAD.slice(0, 7); f.carry!.fromHead = FROM_HEAD.slice(0, 7); }],
    ["a FIX_FIRST verdict", (f) => { f.verdict.value = "FIX_FIRST"; }],
    ["a carry with no sh-carry output", (f) => { Reflect.deleteProperty(f, "carry"); }],
    ["a security kind", (f) => { f.kind = "security"; }, "pr-kind-not-security"],
    ["a missing kind", (f) => { Reflect.deleteProperty(f, "kind"); }, "pr-kind-not-security"],
    ["an unknown kind", (f) => { f.kind = "unknown"; }, "pr-kind-not-security"],
    ["a kind that is not a string", (f) => { Reflect.set(f, "kind", ["feature"]); }, "pr-kind-not-security"],
    ["a carry that is not an object", (f) => { Reflect.set(f, "carry", "equal"); }],
  ];

  it.each(REFUSALS)("falls back to the owner gate on %s", (_name, patch, condition = CARRIED) => {
    const facts = patched(patch);
    expect(unmetConditions([condition as "pr-kind-not-security"], { merge: facts })).toEqual([condition]);
    expect(decide(facts)).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it.each(["correctness", "feature", "refactor"])("allows a carried MERGE of kind %s", (kind) => {
    expect(decide(patched((f) => { f.kind = kind; }))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RC" });
  });

  it.each(["correctness", "security", "feature", "refactor", "unknown", undefined])("leaves MRG-AU-RV unchanged for kind %s", (kind) => {
    const facts = patched((f) => { f.verdict.head = HEAD; Reflect.deleteProperty(f, "carry"); if (kind === undefined) Reflect.deleteProperty(f, "kind"); else f.kind = kind; });
    expect(decide(facts)).toEqual({ verdict: "allow", ruleId: "MRG-AU-RV" });
  });

  it("gates a carried head whose required contexts are not green", () => {
    const facts = patched((f) => { f.checkRuns[0]!.conclusion = "failure"; });
    expect(decide(facts)).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it("gates a carried head that touches a protected path", () => {
    const facts = patched((f) => { f.changedPaths.push(".github/workflows/ci.yml"); });
    expect(decide(facts)).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it("gates a tainted carried merge", () => {
    const request = { action: "merge", actor: { class: "automation", id: "shepherd" }, tainted: true, subject: {}, facts: { merge: carriedFacts() } } as const;
    expect(evaluate(DEFAULT_TABLE, request)).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it.each(["coordinator", "worker", "headless"] as const)("never widens a %s merge", (actor) => {
    const request = { action: "merge", actor: { class: actor, id: "x" }, tainted: false, subject: {}, facts: { merge: carriedFacts() } } as const;
    expect(evaluate(DEFAULT_TABLE, request).verdict).not.toBe("allow");
  });
});
