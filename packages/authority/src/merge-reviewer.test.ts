import { describe, expect, it } from "vitest";
import type { CheckRunFact, MergeFacts } from "./conditions.js";
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

function setFact(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value);
}

function patched(patch: (facts: MergeFacts) => void): MergeFacts {
  const facts = greenFacts();
  patch(facts);
  return facts;
}

const REFUSALS: [string, (facts: MergeFacts) => void, ConditionKind][] = [
  ["a verdict from another agent", (f) => { f.resolver.agentId = "someone-else"; }, "resolver-is-dispatched-reviewer"],
  ["an empty object for resolver and dispatched reviewer", (f) => { setFact(f, "resolver", {}); setFact(f, "dispatchedReviewer", {}); }, "resolver-is-dispatched-reviewer"],
  ["numeric reviewer ids on both sides", (f) => { for (const side of [f.resolver, f.dispatchedReviewer]) { setFact(side, "agentId", 7); setFact(side, "sessionId", 7); } }, "resolver-is-dispatched-reviewer"],
  ["a verdict from a successor session under the same name", (f) => { f.resolver.sessionId = "session-2"; }, "resolver-is-dispatched-reviewer"],
  ["an empty reviewer identity on both sides", (f) => { f.resolver = { agentId: "", sessionId: "" }; f.dispatchedReviewer = { agentId: "", sessionId: "" }; }, "resolver-is-dispatched-reviewer"],
  ["a FIX_FIRST verdict", (f) => { f.verdict.value = "FIX_FIRST"; }, "verdict-merge-at-head"],
  ["a MERGE verdict at an older head", (f) => { f.verdict.head = OLD_HEAD; }, "verdict-merge-at-head"],
  ["a short sha on every side", (f) => { atHead(f, HEAD.slice(0, 7)); }, "verdict-merge-at-head"],
  ["an upper-case sha on every side", (f) => { atHead(f, HEAD.toUpperCase()); }, "verdict-merge-at-head"],
  ["a verdict naming a prefix of the head", (f) => { f.verdict.head = HEAD.slice(0, 7); }, "verdict-merge-at-head"],
  ["a 41-character sha on every side", (f) => { atHead(f, `${HEAD}a`); }, "verdict-merge-at-head"],
  ["a verdict naming the head in upper case", (f) => { f.verdict.head = HEAD.toUpperCase(); }, "verdict-merge-at-head"],
  ["a required context with no run", (f) => { f.requiredContexts.push("e2e"); }, "required-contexts-green"],
  ["a required context green only from another app", (f) => { f.checkRuns[0]!.appId = OTHER_APP; }, "required-contexts-green"],
  ["a required context green only at an older head", (f) => { f.checkRuns[0]!.headSha = OLD_HEAD; }, "required-contexts-green"],
  ["no required contexts at all", (f) => { f.requiredContexts = []; }, "required-contexts-green"],
  ["a required context whose only run concluded neutral", (f) => { f.checkRuns[0]!.conclusion = "neutral"; }, "required-contexts-green"],
  ["a required context whose only run was skipped", (f) => { f.checkRuns[0]!.conclusion = "skipped"; }, "required-contexts-green"],
  ["no allowed apps", (f) => { f.allowedApps = []; }, "required-contexts-green"],
  ["a failed run beside the green required one", (f) => { f.checkRuns.push({ name: "lint", appId: ACTIONS_APP, headSha: HEAD, conclusion: "failure" }); }, "no-non-green-run"],
  ["a failed run with no headSha", (f) => { f.checkRuns.push({ name: "lint", appId: ACTIONS_APP, conclusion: "failure" } as CheckRunFact); }, "no-non-green-run"],
  ["a failed run with a numeric headSha", (f) => { f.checkRuns.push({ name: "lint", appId: ACTIONS_APP, headSha: 1, conclusion: "failure" } as unknown as CheckRunFact); }, "no-non-green-run"],
  ["a failed run with a string appId", (f) => { f.checkRuns.push({ name: "lint", appId: "third-party", headSha: HEAD, conclusion: "failure" } as unknown as CheckRunFact); }, "no-non-green-run"],
  ["a run with no conclusion field", (f) => { f.checkRuns.push({ name: "lint", appId: ACTIONS_APP, headSha: HEAD } as CheckRunFact); }, "no-non-green-run"],
  ["a run still in progress", (f) => { f.checkRuns.push({ name: "lint", appId: ACTIONS_APP, headSha: HEAD, conclusion: null }); }, "no-non-green-run"],
  ["a merge-tree conflict", (f) => { f.mergeTreeClean = false; }, "merge-tree-clean"],
  ["a mergeTreeClean of \"false\"", (f) => { setFact(f, "mergeTreeClean", "false"); }, "merge-tree-clean"],
  ["a mergeTreeClean of 1", (f) => { setFact(f, "mergeTreeClean", 1); }, "merge-tree-clean"],
  ["a frozen repo", (f) => { f.repoFrozen = true; }, "repo-not-frozen"],
  ["a missing repoFrozen", (f) => { Reflect.deleteProperty(f, "repoFrozen"); }, "repo-not-frozen"],
  ["a null repoFrozen", (f) => { setFact(f, "repoFrozen", null); }, "repo-not-frozen"],
  ["a repoFrozen of 0", (f) => { setFact(f, "repoFrozen", 0); }, "repo-not-frozen"],
  ["no changed paths", (f) => { f.changedPaths = []; }, "no-protected-path-change"],
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
  ["a change to .github/x", (f) => { f.changedPaths.push(".github/x"); }, "no-protected-path-change"],
  ["a change to a/../.github/x", (f) => { f.changedPaths.push("a/../.github/x"); }, "no-protected-path-change"],
  ["a change to docs/../CODEOWNERS", (f) => { f.changedPaths.push("docs/../CODEOWNERS"); }, "no-protected-path-change"],
  ["a change to /.github/x", (f) => { f.changedPaths.push("/.github/x"); }, "no-protected-path-change"],
  ["a change to .//.github/x", (f) => { f.changedPaths.push(".//.github/x"); }, "no-protected-path-change"],
  ["a change to docs/./CODEOWNERS", (f) => { f.changedPaths.push("docs/./CODEOWNERS"); }, "no-protected-path-change"],
  ["a change to .GITHUB/x", (f) => { f.changedPaths.push(".GITHUB/x"); }, "no-protected-path-change"],
  ["a change to .github", (f) => { f.changedPaths.push(".github"); }, "no-protected-path-change"],
  ["a change to CODEOWNERS/", (f) => { f.changedPaths.push("CODEOWNERS/"); }, "no-protected-path-change"],
  ["a change to codeowners", (f) => { f.changedPaths.push("codeowners"); }, "no-protected-path-change"],
  ["a change to Docs/CODEOWNERS", (f) => { f.changedPaths.push("Docs/CODEOWNERS"); }, "no-protected-path-change"],
  ["a change to .GitModules", (f) => { f.changedPaths.push(".GitModules"); }, "no-protected-path-change"],
  ["a change to docs\\guide.md", (f) => { f.changedPaths.push("docs\\guide.md"); }, "no-protected-path-change"],
  ["a change to packages//x.ts", (f) => { f.changedPaths.push("packages//x.ts"); }, "no-protected-path-change"],
  ["a change to packages/x/..", (f) => { f.changedPaths.push("packages/x/.."); }, "no-protected-path-change"],
  ["a rename whose old side is under .github/", (f) => { f.changedPaths.push(".github/workflows/old.yml", "tools/old.yml"); }, "no-protected-path-change"],
  ...[".github /x", ".github./x", "CODEOWNERS.", "docs/CODEOWNERS ", "docs./CODEOWNERS"].map(
    (path): [string, (facts: MergeFacts) => void, ConditionKind] => [`a change to ${JSON.stringify(path)}`, (f) => { f.changedPaths.push(path); }, "no-protected-path-change"],
  ),
  ["a hole in the changed paths", (f) => { f.changedPaths.length = 2; }, "no-protected-path-change"],
  ["changed paths that are only a hole", (f) => { f.changedPaths = new Array<string>(1); }, "no-protected-path-change"],
  ["a required context list that is only a hole", (f) => { f.requiredContexts = new Array<string>(1); }, "required-contexts-green"],
  ["changed paths given as an array-like object", (f) => { setFact(f, "changedPaths", { 0: "docs/guide.md", length: 1, some: () => false }); }, "no-protected-path-change"],
  ["a seat grant list given as an object with includes", (f) => { setFact(f, "seatGrants", { includes: () => true }); }, "seat-grants-merge-on-green-approve"],
  ...[".github\u200b/workflows/ci.yml", "CODEOWNERS\n", "docs/CODEOWNERS\u0000", "\uff0egithub/x", ".gitmodules\u007f", "docs/gu\u00efde.md"].map(
    (path): [string, (facts: MergeFacts) => void, ConditionKind] => [`a change to ${JSON.stringify(path)}`, (f) => { f.changedPaths.push(path); }, "no-protected-path-change"],
  ),
  ["seat grants given as a string", (f) => { setFact(f, "seatGrants", "no-merge-on-green-approve"); }, "seat-grants-merge-on-green-approve"],
  ["a seat without merge-on-green-approve", (f) => { f.seatGrants = ["task-close-on-merged-pr"]; }, "seat-grants-merge-on-green-approve"],
];

const MULTI_REFUSALS: [string, (facts: MergeFacts) => void, ConditionKind[]][] = [
  ["an empty head on every side", (f) => { atHead(f, ""); }, ["verdict-merge-at-head", "required-contexts-green", "no-non-green-run"]],
  ["a head given as an array on every side", (f) => { const head = [HEAD]; setFact(f, "head", head); setFact(f.verdict, "head", head); for (const run of f.checkRuns) setFact(run, "headSha", head); }, ["verdict-merge-at-head", "required-contexts-green", "no-non-green-run"]],
  ["allowed apps given as a string holding the app id", (f) => { setFact(f, "allowedApps", String(ACTIONS_APP)); }, ["required-contexts-green", "no-non-green-run"]],
  ["an allowed-apps list with a stray string entry", (f) => { setFact(f, "allowedApps", [ACTIONS_APP, String(ACTIONS_APP)]); }, ["required-contexts-green", "no-non-green-run"]],
  ["a NaN allowed app matching a NaN run app", (f) => { f.allowedApps = [Number.NaN]; f.checkRuns[0]!.appId = Number.NaN; }, ["required-contexts-green", "no-non-green-run"]],
  ["a nameless required context matched by a nameless run", (f) => { setFact(f, "requiredContexts", [undefined]); Reflect.deleteProperty(f.checkRuns[0]!, "name"); }, ["required-contexts-green", "no-non-green-run"]],
  ["a sparse required context list with no check runs", (f) => { f.requiredContexts = new Array<string>(1); f.checkRuns = []; }, ["required-contexts-green"]],
  ["allowed apps given as an array-like object", (f) => { setFact(f, "allowedApps", { length: 1, every: () => true, includes: () => true }); }, ["required-contexts-green", "no-non-green-run"]],
];

const UNREADABLE: [string, () => AuthorityRequest][] = [
  ["a merge getter that throws", () => ({ ...mergeBy("automation", undefined), facts: { get merge(): MergeFacts { throw new Error("boom"); } } })],
  ["a facts getter that throws", () => Object.defineProperty(mergeBy("automation", undefined), "facts", { get: () => { throw new Error("boom"); } })],
  ["a cycle in the facts", () => { const facts = greenFacts(); setFact(facts, "self", facts); return mergeBy("automation", facts); }],
  ["a BigInt fact", () => mergeBy("automation", patched((f) => { setFact(f, "extra", 1n); }))],
  ["a changed path getter that throws", () => mergeBy("automation", patched((f) => { Object.defineProperty(f.changedPaths, 0, { get: () => { throw new Error("boom"); } }); }))],
];

const NOT_UNTAINTED: unknown[] = [true, undefined, null, 0, "", "false", 1, "true"];

function withoutRow(ruleId: string): typeof DEFAULT_TABLE {
  return { ...DEFAULT_TABLE, rules: DEFAULT_TABLE.rules.filter((rule) => rule.id !== ruleId) };
}

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

  it.each(MULTI_REFUSALS)("gates on %s, failing every condition that reads the fact", (_name, patch, conditions) => {
    const facts = patched(patch);
    expect(unmetConditions(CONDITION_KINDS, { merge: facts })).toEqual(conditions);
    expect(evaluate(DEFAULT_TABLE, mergeBy("automation", facts))).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it("gates a tainted automation merge even when every fact is green", () => {
    const decision = evaluate(DEFAULT_TABLE, mergeBy("automation", greenFacts(), true));
    expect(decision).toMatchObject({ verdict: "gate", ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"] });
    expect(decision.verdict === "gate" && decision.reason).toContain("MRG-AU-RV skipped: tainted");
  });

  it.each(NOT_UNTAINTED)("decides a merge tainted %j exactly as the table without MRG-AU-RV does", (tainted) => {
    const request = { ...mergeBy("automation", greenFacts()), tainted } as AuthorityRequest;
    const decision = evaluate(DEFAULT_TABLE, request);
    const { verdict, ruleId } = evaluate(withoutRow("MRG-AU-RV"), request);
    expect(decision).toMatchObject({ verdict, ruleId });
    expect(decision).toMatchObject({ verdict: "gate", ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"] });
  });

  it.each(UNREADABLE)("gates rather than throws on %s", (_name, request) => {
    const decision = evaluate(DEFAULT_TABLE, request());
    expect(decision).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
    expect(decision.verdict === "gate" && decision.reason).toContain(`MRG-AU-RV unmet: ${CONDITION_KINDS.join(", ")}`);
  });

  it.each(["docs/guide.md", ".githubx/notes.md", "packages/x/CODEOWNERS.md"])("allows a change to the unprotected path %s", (path) => {
    const facts = patched((f) => { f.changedPaths.push(path); });
    expect(evaluate(DEFAULT_TABLE, mergeBy("automation", facts))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RV" });
  });

  it("gates an automation merge that brings no facts", () => {
    expect(evaluate(DEFAULT_TABLE, mergeBy("automation", undefined))).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
  });

  it("gates rather than throws when the check runs are missing", () => {
    const facts = patched((f) => { Reflect.deleteProperty(f, "checkRuns"); });
    expect(unmetConditions(CONDITION_KINDS, { merge: facts })).toEqual(["required-contexts-green", "no-non-green-run"]);
    const decision = evaluate(DEFAULT_TABLE, mergeBy("automation", facts));
    expect(decision).toMatchObject({ verdict: "gate", ruleId: "MRG-AU" });
    expect(decision.verdict === "gate" && decision.reason).toContain("MRG-AU-RV unmet: required-contexts-green, no-non-green-run");
  });

  it("ignores a failed run from an app outside the allowed list", () => {
    const facts = patched((f) => { f.checkRuns.push({ name: "third-party", appId: OTHER_APP, headSha: HEAD, conclusion: "failure" }); });
    expect(evaluate(DEFAULT_TABLE, mergeBy("automation", facts))).toEqual({ verdict: "allow", ruleId: "MRG-AU-RV" });
  });

  it.each(["coordinator", "worker", "headless"] as const)("never widens a %s merge", (actor) => {
    expect(evaluate(DEFAULT_TABLE, mergeBy(actor, greenFacts())).verdict).not.toBe("allow");
  });
});
