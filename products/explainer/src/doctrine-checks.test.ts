import { describe, expect, it } from "vitest";
import { checkDoctrine, isCodeEnforced, type DoctrineIssueCode } from "./doctrine-checks.js";
import { Q_RULES, craftRule, registryWith } from "./doctrine-fixtures.test-helpers.js";
import type { DoctrineRule } from "./doctrine-schema.js";

const codesFor = (...rules: DoctrineRule[]): DoctrineIssueCode[] => checkDoctrine(registryWith(...rules), Q_RULES).map((found) => found.code);

describe("checkDoctrine", () => {
  it("accepts a sound universal rule", () => {
    expect(checkDoctrine(registryWith(craftRule()), Q_RULES)).toEqual([]);
  });

  it("names an evidence id the ledger does not hold", () => {
    const issues = checkDoctrine(registryWith(craftRule({ evidence: ["E01", "E99"], grade: "A" })), Q_RULES);

    expect(issues).toEqual([expect.objectContaining({ code: "missing-evidence", rule: "dir-P1", message: expect.stringContaining("E99") })]);
  });

  it("rejects a grade that none of the cited rows states, even a weaker one", () => {
    expect(codesFor(craftRule({ evidence: ["E02"], grade: "A" }))).toEqual(["grade-not-in-evidence"]);
    expect(codesFor(craftRule({ evidence: ["E01"], grade: "C" }))).toEqual(["grade-not-in-evidence"]);
  });

  it("accepts any grade a compound ledger cell states", () => {
    expect(codesFor(craftRule({ evidence: ["E03"], grade: "D" }))).toEqual([]);
  });

  it("asks a rule that cites evidence for its grade", () => {
    expect(codesFor(craftRule({ evidence: ["E01"] }))).toEqual(["missing-grade"]);
  });

  it("flags a live gate rule that also reaches the planner prompt", () => {
    const rule = craftRule({ enforcement: ["gate", "planner"], stages: ["plan", "qa"], check: { kind: "gate", ref: "gate.readingHold", live: true } });

    expect(codesFor(rule)).toEqual(["code-rule-in-prompt-enforcement"]);
  });

  it("lets a rule whose gate is not live yet reach the prompt as the fallback", () => {
    const rule = craftRule({ enforcement: ["gate", "planner"], stages: ["plan", "qa"], check: { kind: "gate", ref: "gate.readingHold", live: false } });

    expect(codesFor(rule)).toEqual([]);
  });

  it("treats a rule as code-enforced only when every token is live", () => {
    const partly = craftRule({ enforcement: ["token", "base"], tokens: [{ name: "MOTION.video.dim", live: true }, { name: "MOTION.video.hold", live: false }] });
    const fully = craftRule({ enforcement: ["token", "base"], tokens: [{ name: "MOTION.video.dim", live: true }] });

    expect([isCodeEnforced(partly), codesFor(partly)]).toEqual([false, []]);
    expect([isCodeEnforced(fully), codesFor(fully)]).toEqual([true, ["code-rule-in-prompt-enforcement"]]);
  });

  it("resolves qrule checks against the Q-registry and its L0 status", () => {
    const qrule = (ref: string, live: boolean): DoctrineRule =>
      craftRule({ enforcement: ["lint"], stages: ["qa"], check: { kind: "qrule", ref, live } });

    expect(codesFor(qrule("Q-X99", false))).toEqual(["unknown-qrule"]);
    expect(codesFor(qrule("Q-V1", false))).toEqual(["qrule-live-mismatch"]);
    expect(codesFor(qrule("Q-W1", true))).toEqual(["qrule-live-mismatch"]);
    expect(codesFor(qrule("X1", true), qrule("Q-W1", false))).toEqual(["duplicate-id"]);
  });

  it.each<[string, Partial<DoctrineRule>, DoctrineIssueCode]>([
    ["a B rule with no beats", { scope: { layer: "B" } }, "beat-rule-without-beats"],
    ["a T rule with no type or audience", { scope: { layer: "T" } }, "type-rule-without-target"],
    ["a U rule scoped to beats", { scope: { layer: "U", beats: ["hook"] } }, "universal-rule-scoped"],
    ["a U* rule with no param", { scope: { layer: "U*" } }, "param-missing"],
    ["a beat missing from the vocabulary", { scope: { layer: "B", beats: ["dance"] } }, "unknown-vocabulary"],
    ["an audience missing from the vocabulary", { scope: { layer: "T", audiences: ["investors"] } }, "unknown-vocabulary"],
    ["a check with no lint or gate enforcement", { check: { kind: "lint", ref: "lint.x", live: false } }, "check-enforcement-mismatch"],
    ["a gate enforcement with no check", { enforcement: ["gate"] }, "check-enforcement-mismatch"],
    ["a token enforcement with no tokens", { enforcement: ["token"] }, "token-enforcement-mismatch"],
    ["an unresolved supersedes", { supersedes: ["talks-B7"] }, "unknown-supersedes"],
    ["a Q- id", { id: "Q-V1" }, "reserved-q-id"],
  ])("reports %s with its own code", (_scenario, overrides, code) => {
    expect(codesFor(craftRule(overrides))).toEqual([code]);
  });

  it("reports both rules sharing an id once", () => {
    expect(codesFor(craftRule(), craftRule())).toEqual(["duplicate-id"]);
  });

  it("accepts scoped rules and a resolved supersedes", () => {
    const beat = craftRule({ id: "dir-C3", source: { doc: "direction", ref: "C3" }, scope: { layer: "B", beats: ["code-walk"] }, enforcement: ["packet"] });
    const typed = craftRule({ id: "dir-C9", source: { doc: "direction", ref: "C9" }, scope: { layer: "T", types: ["repo-argument"], audiences: ["public-youtube"] }, enforcement: ["planner"], stages: ["plan"] });
    const starred = craftRule({ id: "dir-P6", source: { doc: "direction", ref: "P6" }, scope: { layer: "U*" }, param: "chapters.count", supersedes: ["dir-P1"] });

    expect(codesFor(craftRule(), beat, typed, starred)).toEqual([]);
  });
});
