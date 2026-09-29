import { describe, expect, it } from "vitest";
import type { MergeFacts } from "./conditions.js";
import { unmetConditions } from "./conditions.js";
import type { AuthorityRequest } from "./evaluate.js";
import { evaluate } from "./evaluate.js";
import { DEFAULT_TABLE } from "./table.js";
import type { ActorClass, ConditionKind } from "./vocabulary.js";
import { CONDITION_KINDS } from "./vocabulary.js";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const ACTIONS_APP = 15368;
const OTHER_APP = 99;
const REVIEWER = { agentId: "tc-tp-461-reviewer", sessionId: "session-1" };

function greenFacts(): MergeFacts {
  return {
    head: HEAD,
    resolver: { ...REVIEWER },
    dispatchedReviewer: { ...REVIEWER },
    verdict: { value: "MERGE", head: HEAD },
    requiredContexts: ["check"],
    allowedApps: [ACTIONS_APP],
    checkRuns: [
      { name: "check", appId: ACTIONS_APP, headSha: HEAD, conclusion: "success" },
      { name: "docs", appId: ACTIONS_APP, headSha: HEAD, conclusion: "skipped" },
    ],
    mergeTreeClean: true,
    repoFrozen: false,
    changedPaths: ["packages/authority/src/table.json"],
    seatGrants: ["merge-on-green-approve", "task-close-on-merged-pr"],
  };
}

function mergeBy(actor: ActorClass, facts: MergeFacts | undefined, tainted = false): AuthorityRequest {
  return { action: "merge", actor: { class: actor, id: "shepherd" }, tainted, subject: {}, facts: facts && { merge: facts } };
}

function atHead(facts: MergeFacts, head: string): void {
  facts.head = head;
  facts.verdict.head = head;
  for (const run of facts.checkRuns) run.headSha = head;
}

function patched(patch: (facts: MergeFacts) => void): MergeFacts {
  const facts = greenFacts();
  patch(facts);
  return facts;
}

const REFUSALS: [string, (facts: MergeFacts) => void, ConditionKind][] = [
  ["a verdict from another agent", (f) => { f.resolver.agentId = "someone-else"; }, "resolver-is-dispatched-reviewer"],
  ["a verdict from a successor session under the same name", (f) => { f.resolver.sessionId = "session-2"; }, "resolver-is-dispatched-reviewer"],
  ["an empty reviewer identity on both sides", (f) => { f.resolver = { agentId: "", sessionId: "" }; f.dispatchedReviewer = { agentId: "", sessionId: "" }; }, "resolver-is-dispatched-reviewer"],
  ["a FIX_FIRST verdict", (f) => { f.verdict.value = "FIX_FIRST"; }, "verdict-merge-at-head"],
  ["a MERGE verdict at an older head", (f) => { f.verdict.head = OLD_HEAD; }, "verdict-merge-at-head"],
  ["a short sha on every side", (f) => { atHead(f, HEAD.slice(0, 7)); }, "verdict-merge-at-head"],
  ["an upper-case sha on every side", (f) => { atHead(f, HEAD.toUpperCase()); }, "verdict-merge-at-head"],
  ["an empty head on every side", (f) => { atHead(f, ""); }, "verdict-merge-at-head"],
  ["a verdict naming a prefix of the head", (f) => { f.verdict.head = HEAD.slice(0, 7); }, "verdict-merge-at-head"],
  ["a verdict naming the head in upper case", (f) => { f.verdict.head = HEAD.toUpperCase(); }, "verdict-merge-at-head"],
  ["a required context with no run", (f) => { f.requiredContexts.push("e2e"); }, "required-contexts-green"],
  ["a required context green only from another app", (f) => { f.checkRuns[0]!.appId = OTHER_APP; }, "required-contexts-green"],
  ["a required context green only at an older head", (f) => { f.checkRuns[0]!.headSha = OLD_HEAD; }, "required-contexts-green"],
  ["no required contexts at all", (f) => { f.requiredContexts = []; }, "required-contexts-green"],
  ["no allowed apps", (f) => { f.allowedApps = []; }, "required-contexts-green"],
  ["a failed run beside the green required one", (f) => { f.checkRuns.push({ name: "lint", appId: ACTIONS_APP, headSha: HEAD, conclusion: "failure" }); }, "no-non-green-run"],
  ["a run still in progress", (f) => { f.checkRuns.push({ name: "lint", appId: ACTIONS_APP, headSha: HEAD, conclusion: null }); }, "no-non-green-run"],
  ["a merge-tree conflict", (f) => { f.mergeTreeClean = false; }, "merge-tree-clean"],
  ["a frozen repo", (f) => { f.repoFrozen = true; }, "repo-not-frozen"],
  ["a change to .github/workflows/ci.yml", (f) => { f.changedPaths.push(".github/workflows/ci.yml"); }, "no-protected-path-change"],
  ["a change to .github/actions/setup/action.yml", (f) => { f.changedPaths.push(".github/actions/setup/action.yml"); }, "no-protected-path-change"],
  ["a change to .github/CODEOWNERS", (f) => { f.changedPaths.push(".github/CODEOWNERS"); }, "no-protected-path-change"],
  ["a change to .github/dependabot.yml", (f) => { f.changedPaths.push(".github/dependabot.yml"); }, "no-protected-path-change"],
  ["a change to .github/rulesets/main.json", (f) => { f.changedPaths.push(".github/rulesets/main.json"); }, "no-protected-path-change"],
  ["a change to CODEOWNERS", (f) => { f.changedPaths.push("CODEOWNERS"); }, "no-protected-path-change"],
  ["a change to docs/CODEOWNERS", (f) => { f.changedPaths.push("docs/CODEOWNERS"); }, "no-protected-path-change"],
  ["a change to .gitmodules", (f) => { f.changedPaths.push(".gitmodules"); }, "no-protected-path-change"],
  ["a change to ./.github/workflows/ci.yml", (f) => { f.changedPaths.push("./.github/workflows/ci.yml"); }, "no-protected-path-change"],
  ["a change to ./CODEOWNERS", (f) => { f.changedPaths.push("./CODEOWNERS"); }, "no-protected-path-change"],
  ["a seat without merge-on-green-approve", (f) => { f.seatGrants = ["task-close-on-merged-pr"]; }, "seat-grants-merge-on-green-approve"],
];

describe("MRG-AU-RV: an automation merge on the dispatched reviewer's verdict", () => {
  it("allows when every condition holds at the exact head", () => {
    expect(evaluate(DEFAULT_TABLE, mergeBy("automation", greenFacts()))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RV" });
  });

  it("checks all eight conditions the owner approved", () => {
    const row = DEFAULT_TABLE.rules.find((rule) => rule.id === "MRG-AU-RV");
    expect([...(row?.when ?? [])].sort()).toEqual([...CONDITION_KINDS].sort());
  });

  it.each(REFUSALS)("falls back to the MRG-AU owner gate on %s", (_name, patch, condition) => {
    const facts = patched(patch);
    expect(unmetConditions(CONDITION_KINDS, { merge: facts })).toEqual([condition]);
    const decision = evaluate(DEFAULT_TABLE, mergeBy("automation", facts));
    expect(decision).toMatchObject({ verdict: "gate", ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"] });
    expect(decision.verdict === "gate" && decision.reason).toContain(`MRG-AU-RV unmet: ${condition}`);
  });

  it("gates a tainted automation merge even when every fact is green", () => {
    const decision = evaluate(DEFAULT_TABLE, mergeBy("automation", greenFacts(), true));
    expect(decision).toMatchObject({ verdict: "gate", ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"] });
    expect(decision.verdict === "gate" && decision.reason).toContain("MRG-AU-RV skipped: tainted");
  });

  it.each(["docs/guide.md", ".githubx/notes.md", "packages/x/CODEOWNERS.md"])("allows a change to the unprotected path %s", (path) => {
    const facts = patched((f) => { f.changedPaths.push(path); });
    expect(evaluate(DEFAULT_TABLE, mergeBy("automation", facts))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RV" });
  });

  it("gates an automation merge that brings no facts", () => {
    expect(evaluate(DEFAULT_TABLE, mergeBy("automation", undefined))).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it("ignores a failed run from an app outside the allowed list", () => {
    const facts = patched((f) => { f.checkRuns.push({ name: "third-party", appId: OTHER_APP, headSha: HEAD, conclusion: "failure" }); });
    expect(evaluate(DEFAULT_TABLE, mergeBy("automation", facts))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RV" });
  });

  it.each(["coordinator", "worker", "headless"] as const)("never widens a %s merge", (actor) => {
    expect(evaluate(DEFAULT_TABLE, mergeBy(actor, greenFacts())).verdict).not.toBe("allow");
  });
});
