import { describe, expect, it } from "vitest";
import type { MergeFacts } from "./conditions.js";
import { unmetConditions } from "./conditions.js";
import type { AuthorityRequest } from "./evaluate.js";
import { canResolve, evaluate } from "./evaluate.js";
import { DEFAULT_TABLE } from "./table.js";
import type { ActionClass, ActorClass, ConditionKind } from "./vocabulary.js";
import { DELEGATE_RESOLVER_CLASSES } from "./vocabulary.js";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const APP = 15368;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPENED_AT = Date.UTC(2026, 0, 1);

const WHEN: ConditionKind[] = [
  "owner-gate-silent-24h",
  "gate-recommends-merge",
  "verdict-by-dispatched-reviewer",
  "verdict-merge-at-head",
  "required-contexts-green",
  "no-non-green-run",
  "merge-tree-clean",
  "repo-not-frozen",
  "no-protected-path-change",
  "no-hold",
  "no-owner-path",
  "no-release-path",
];

// The row exactly as the owner approves it (TP-6765 plan, step OS1).
const APPROVED_ROW = {
  id: "MRG-AU-RB",
  action: "merge",
  actor: "automation",
  verdict: "allow",
  condition:
    "Owner decision 2026-11-19 (TP-6765): an approve-merge gate whose recommended answer is merge and that the owner left unanswered for 24 h at the same head resolves to merge, logged as auto-by-rec. The dispatched reviewer's MERGE at the exact head and green required checks still hold at resolve time; the PR carries no Shepherd hold of any class and no protected, release, authority or owner-tier path. Otherwise MRG-AU gates.",
  when: WHEN,
  evidence: ["E-gate", "E-gh", "E-rev"],
};

/** A gate left a day at its head with merge recommended, on a clean PR. Shepherd, not the reviewer, asks, and no seat grants merge-on-green, so MRG-AU-RV cannot match. */
function byRecFacts(): MergeFacts {
  return {
    head: HEAD,
    resolver: { agentId: "shepherd", sessionId: "serve-1" },
    dispatchedReviewer: { agentId: "rv-1", sessionId: "session-1" },
    verdict: { value: "MERGE", head: HEAD, author: { agentId: "rv-1", sessionId: "session-1" } },
    requiredContexts: ["check"],
    allowedApps: [APP],
    checkRuns: [{ name: "check", appId: APP, headSha: HEAD, conclusion: "success" }],
    mergeTreeClean: true,
    repoFrozen: false,
    changedPaths: ["packages/example/src/a.ts"],
    seatGrants: [],
    ownerGate: { head: HEAD, pending: true, recommended: "merge", openedAt: OPENED_AT, observedAt: OPENED_AT + DAY_MS },
    holdClasses: [],
    ownerTierPaths: [],
    headRef: "agent-chat/example",
  };
}

function patched(patch: (facts: MergeFacts) => void): MergeFacts {
  const facts = byRecFacts();
  patch(facts);
  return facts;
}

function request(facts: MergeFacts | undefined, actor: ActorClass = "automation", action: ActionClass = "merge", tainted = false): AuthorityRequest {
  return { action, actor: { class: actor, id: "shepherd" }, tainted, subject: {}, facts: facts && { merge: facts } };
}

function expectFallsBackToGate(facts: MergeFacts, condition: ConditionKind): void {
  const decision = evaluate(DEFAULT_TABLE, request(facts));
  expect(decision).toMatchObject({ verdict: "gate", ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"] });
  expect(decision.verdict === "gate" && decision.reason).toMatch(new RegExp(`MRG-AU-RB unmet: (?:[a-z0-9-]+, )*${condition}(?:, |$)`));
}

const gate = (facts: MergeFacts) => facts.ownerGate!;

// Mergeability conditions the row shares with MRG-AU-RV; the row's text does not name them, and they only narrow it.
const UNNAMED_IN_TEXT: ConditionKind[] = ["merge-tree-clean", "repo-not-frozen"];

// Each clause of the row's text, the conditions that enforce it, and a patch that removes the clause's fact.
const CLAUSES: [string, ConditionKind[], (facts: MergeFacts) => void][] = [
  ["recommended answer is merge", ["gate-recommends-merge"], (f) => { gate(f).recommended = null; }],
  ["unanswered for 24 h at the same head", ["owner-gate-silent-24h"], (f) => { gate(f).observedAt = OPENED_AT; }],
  ["The dispatched reviewer's MERGE", ["verdict-by-dispatched-reviewer"], (f) => { Reflect.deleteProperty(f.verdict, "author"); }],
  ["at the exact head", ["verdict-merge-at-head"], (f) => { f.verdict.head = ""; }],
  ["green required checks", ["required-contexts-green", "no-non-green-run"], (f) => { f.checkRuns[0]!.conclusion = null; }],
  ["no Shepherd hold of any class", ["no-hold"], (f) => { Reflect.deleteProperty(f, "holdClasses"); }],
  ["protected", ["no-protected-path-change"], (f) => { f.changedPaths = []; }],
  ["release", ["no-release-path"], (f) => { Reflect.deleteProperty(f, "headRef"); }],
  ["authority or owner-tier path", ["no-owner-path"], (f) => { Reflect.deleteProperty(f, "ownerTierPaths"); }],
];

const ONE_FALSE: [string, ConditionKind, (facts: MergeFacts) => void][] = [
  ["the gate is a millisecond short of 24 h", "owner-gate-silent-24h", (f) => { gate(f).observedAt = OPENED_AT + DAY_MS - 1; }],
  ["the gate's open time is not an integer", "owner-gate-silent-24h", (f) => { gate(f).openedAt = OPENED_AT + 0.5; }],
  ["the gate's open time is an ISO string", "owner-gate-silent-24h", (f) => { Reflect.set(gate(f), "openedAt", "2026-01-01T00:00:00Z"); }],
  ["the gate has no open time", "owner-gate-silent-24h", (f) => { gate(f).openedAt = 0; }],
  ["the gate was observed before it opened", "owner-gate-silent-24h", (f) => { gate(f).observedAt = OPENED_AT - DAY_MS; }],
  ["the gate recommends abandon", "gate-recommends-merge", (f) => { gate(f).recommended = "abandon"; }],
  ["the gate recommends nothing", "gate-recommends-merge", (f) => { gate(f).recommended = null; }],
  ["the gate recommends MERGE in upper case", "gate-recommends-merge", (f) => { gate(f).recommended = "MERGE"; }],
  ["the MERGE came from another reviewer", "verdict-by-dispatched-reviewer", (f) => { f.verdict.author = { agentId: "rv-2", sessionId: "session-2" }; }],
  ["the MERGE came from the dispatched agent in another session", "verdict-by-dispatched-reviewer", (f) => { f.verdict.author = { agentId: "rv-1", sessionId: "session-2" }; }],
  ["the MERGE has no author", "verdict-by-dispatched-reviewer", (f) => { Reflect.deleteProperty(f.verdict, "author"); }],
  ["the MERGE's author is not a record", "verdict-by-dispatched-reviewer", (f) => { Reflect.set(f.verdict, "author", "rv-1"); }],
  ["the MERGE and the dispatched reviewer are both blank", "verdict-by-dispatched-reviewer", (f) => {
    f.dispatchedReviewer = { agentId: "", sessionId: "" };
    f.verdict.author = { agentId: "", sessionId: "" };
  }],
  ["the reviewer's MERGE is at an older head", "verdict-merge-at-head", (f) => { f.verdict.head = OLD_HEAD; }],
  ["the reviewer said FIX_FIRST", "verdict-merge-at-head", (f) => { f.verdict.value = "FIX_FIRST"; }],
  ["a required context has no run", "required-contexts-green", (f) => { f.requiredContexts.push("e2e"); }],
  ["a check is still running", "no-non-green-run", (f) => { f.checkRuns.push({ name: "lint", appId: APP, headSha: HEAD, conclusion: null }); }],
  ["the merge tree conflicts", "merge-tree-clean", (f) => { f.mergeTreeClean = false; }],
  ["the repo is frozen", "repo-not-frozen", (f) => { f.repoFrozen = true; }],
  ["the PR changes CODEOWNERS", "no-protected-path-change", (f) => { f.changedPaths.push("docs/CODEOWNERS"); }],
  ["the PR carries a g10-review hold", "no-hold", (f) => { f.holdClasses = ["g10-review"]; }],
  ["Shepherd's owner tier holds a changed path", "no-owner-path", (f) => { f.ownerTierPaths = ["packages/example/src/a.ts"]; }],
  ["the PR is a release branch", "no-release-path", (f) => { f.headRef = "changeset-release/main"; }],
];

describe("MRG-AU-RB: automation merges an approve-merge gate left 24 h on a merge recommendation", () => {
  it("is the row the owner approved, word for word", () => {
    expect(DEFAULT_TABLE.rules.find((rule) => rule.id === "MRG-AU-RB")).toEqual(APPROVED_ROW);
  });

  it("enforces every clause of its text with a condition in its when list", () => {
    const named = CLAUSES.flatMap(([clause, conditions]) => {
      expect(APPROVED_ROW.condition).toContain(clause);
      return conditions;
    });
    expect([...named, ...UNNAMED_IN_TEXT].sort()).toEqual([...WHEN].sort());
  });

  it.each(CLAUSES)("gates when the fact behind %j is missing", (_clause, conditions, patch) => {
    const unmet = unmetConditions(WHEN, { merge: patched(patch) });
    expect(unmet).toEqual(expect.arrayContaining(conditions));
    expectFallsBackToGate(patched(patch), conditions[0]!);
  });

  it("allows the merge when every condition holds, and only then", () => {
    expect(unmetConditions(WHEN, { merge: byRecFacts() })).toEqual([]);
    expect(evaluate(DEFAULT_TABLE, request(byRecFacts()))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RB" });
  });

  it("allows at exactly 24 h and later", () => {
    const later = patched((f) => { gate(f).observedAt = OPENED_AT + 3 * DAY_MS; });
    expect(evaluate(DEFAULT_TABLE, request(later))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RB" });
  });

  it.each(ONE_FALSE)("falls back to the MRG-AU gate when %s", (_name, condition, patch) => {
    const facts = patched(patch);
    expect(unmetConditions(WHEN, { merge: facts })).toEqual([condition]);
    expectFallsBackToGate(facts, condition);
  });

  it.each([
    ["the gate is at an older head", (f: MergeFacts) => { gate(f).head = OLD_HEAD; }],
    ["the gate was answered", (f: MergeFacts) => { gate(f).pending = false; }],
    ["no gate was read", (f: MergeFacts) => { Reflect.deleteProperty(f, "ownerGate"); }],
  ])("checks neither the silence nor the recommendation when %s", (_name, patch) => {
    const facts = patched(patch);
    expect(unmetConditions(WHEN, { merge: facts })).toEqual(["owner-gate-silent-24h", "gate-recommends-merge"]);
    expectFallsBackToGate(facts, "owner-gate-silent-24h");
  });

  it("never matches a tainted request or one with no facts", () => {
    expect(evaluate(DEFAULT_TABLE, request(byRecFacts(), "automation", "merge", true))).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
    expect(evaluate(DEFAULT_TABLE, request(undefined))).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });
});

describe("MRG-AU-RB's exclusion floor", () => {
  it.each(["g10-review", "g10-adversary", "owner-asked", "owner-review", "visual-gate2", ""])("never matches a PR held %j", (holdClass) => {
    expectFallsBackToGate(patched((f) => { f.holdClasses = [holdClass]; }), "no-hold");
  });

  it.each([
    ["holdClasses missing", (f: MergeFacts) => { Reflect.deleteProperty(f, "holdClasses"); }],
    ["holdClasses not a list", (f: MergeFacts) => { Reflect.set(f, "holdClasses", "none"); }],
    ["a non-string hold class", (f: MergeFacts) => { Reflect.set(f, "holdClasses", [7]); }],
  ])("fails closed on %s", (_name, patch) => {
    expectFallsBackToGate(patched(patch), "no-hold");
  });

  it.each([
    ["ownerTierPaths missing", (f: MergeFacts) => { Reflect.deleteProperty(f, "ownerTierPaths"); }],
    ["ownerTierPaths not a list", (f: MergeFacts) => { Reflect.set(f, "ownerTierPaths", false); }],
    ["a non-string owner-tier path", (f: MergeFacts) => { Reflect.set(f, "ownerTierPaths", [7]); }],
  ])("fails closed on %s", (_name, patch) => {
    expectFallsBackToGate(patched(patch), "no-owner-path");
  });

  it.each([
    "packages/authority/src/table.json",
    "Packages/Authority/src/table.json",
    "packages/authority",
    "packages/tool-guard/src/families/merge.ts",
    ".github/workflows/ci.yml",
    ".github/fix-proof.json",
    ".codewatch/check.json",
    ".egress-allow",
    ".claude/skills/review/SKILL.md",
    ".Claude/Skills/x",
    ".claude",
    ".claude/settings.json",
    ".agent-chat/profiles/x.json",
    "products/factory/src/config.ts",
    "products/factory/src/config-ref.ts",
    "products/factory/src/cli-release.ts",
    "products/factory/src/shepherd/merge-facts.ts",
    "products/factory/src/shepherd/version-packages.ts",
    "products/factory/src/shepherd/release-follow.ts",
    "products/factory/src/shepherd/bump-consumers.ts",
    "products/factory/src/shepherd/commands.ts",
    "products/example/src/g10-classes.ts",
    "packages/example/src/risk-tier.ts",
    "packages/example/src/owner-tier.ts",
    "packages/example/src/merge-evidence-gate.ts",
    "apps/console/server/routes/owner-tap.ts",
    "apps/console/server/inbox-actions-list.ts",
    "products/factory/src/gate-resolve-sink.ts",
    "products/factory/src/cli/owner-release.ts",
    "packages/hitl/src/store.ts",
    "packages/x/../authority/src/table.json",
  ])("never matches a PR touching %s, even when the caller's owner-tier read is empty", (path) => {
    expectFallsBackToGate(patched((f) => { f.changedPaths.push(path); }), "no-owner-path");
  });

  it.each(["changeset-release/main", "fork:changeset-release/main", "release/1.0", "Changeset-Release/main", "refs/heads/changeset-release/main", "refs/heads/release/x", ""])("never matches head branch %j", (headRef) => {
    expectFallsBackToGate(patched((f) => { f.headRef = headRef; }), "no-release-path");
  });

  it("fails closed on a missing head branch", () => {
    expectFallsBackToGate(patched((f) => { Reflect.deleteProperty(f, "headRef"); }), "no-release-path");
  });

  it.each(["CHANGELOG.md", "packages/example/CHANGELOG.md", ".changeset/config.json", ".changeset/pre.json"])("never matches a PR touching release file %s", (path) => {
    expectFallsBackToGate(patched((f) => { f.changedPaths.push(path); }), "no-release-path");
  });

  it("lets a PR that adds an ordinary changeset through", () => {
    const facts = patched((f) => { f.changedPaths.push(".changeset/quiet-owls-sing.md"); });
    expect(evaluate(DEFAULT_TABLE, request(facts))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RB" });
  });
});

describe("what MRG-AU-RB leaves alone", () => {
  it("still denies a decider's merge on facts that satisfy MRG-AU-RB", () => {
    expect(evaluate(DEFAULT_TABLE, request(byRecFacts(), "decider"))).toMatchObject({ verdict: "deny", ruleId: "MRG-DC" });
  });

  it("leaves every release row as it was, with no conditional release row", () => {
    const releaseRows = DEFAULT_TABLE.rules.filter((rule) => rule.action === "release").map((rule) => [rule.id, rule.verdict, rule.when]);
    expect(releaseRows).toEqual([
      ["REL-OT", "allow", undefined],
      ["REL-OR", "deny", undefined],
      ["REL-CO", "gate", undefined],
      ["REL-WK", "deny", undefined],
      ["REL-HD", "deny", undefined],
      ["REL-AU", "allow", undefined],
      ["REL-DC", "deny", undefined],
    ]);
  });

  it("still denies a decider's release on facts that satisfy MRG-AU-RB", () => {
    expect(evaluate(DEFAULT_TABLE, request(byRecFacts(), "decider", "release"))).toMatchObject({ verdict: "deny", ruleId: "REL-DC" });
  });

  it("adds no delegate resolver and lets automation resolve no gate", () => {
    expect(DELEGATE_RESOLVER_CLASSES).toEqual(["coordinator"]);
    expect(canResolve(DEFAULT_TABLE, "MRG-AU", { class: "automation", tainted: false })).toBe(false);
  });
});
