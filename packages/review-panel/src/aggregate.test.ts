import { lineSourceFromTexts } from "@titan-design/evidence";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { aggregate } from "./aggregate.js";
import type { AggregateInput, MemberResult } from "./aggregate.js";
import { classifyPr } from "./classify.js";
import { MAX_FIX_FIRST_TEXT_CHARS } from "./fix-first-findings.js";
import { DEFAULT_PANEL_POLICY, DEFAULT_PANEL_TABLE, planPanel } from "./plan.js";
import type { PanelPolicy } from "./plan.js";
import type { PanelPlan, PrTouch, ReviewClass, ReviewShape } from "./types.js";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const locator = partialFake<SourceTextLocator>();
/** A result read back from stored JSON, so its fields carry no type guarantee. */
const stored = (value: unknown): MemberResult => JSON.parse(JSON.stringify(value));
const reviewer = { agentId: "agent-1", sessionId: "session-1" };
const PANEL: PanelPolicy = { ...DEFAULT_PANEL_POLICY, panel: DEFAULT_PANEL_TABLE };
const source = lineSourceFromTexts({ "src/gate.ts": "one\ntwo\nthree\n", "src/view.tsx": "a\nb\n" });
const input: AggregateInput = { head: HEAD, source };

const plan = (klass: ReviewClass, touches: PrTouch[] = [], opus = true, policy = PANEL): PanelPlan => planPanel({ class: klass, touches }, policy, { opus });
const G10 = plan("g10", ["authority"]);
const merge = (shape: ReviewShape, head = HEAD): MemberResult => ({ shape, result: { kind: "verdict", head, locator, reviewer, verdict: "MERGE" } });
const fixFirst = (shape: ReviewShape, text: string, closer?: "yes" | "no"): MemberResult => ({
  shape,
  result: { kind: "verdict", head: HEAD, locator, reviewer, verdict: "FIX_FIRST", text, ...(closer && { closer }) },
});
const none = (shape: ReviewShape): MemberResult => ({ shape, result: { kind: "none" } });
const timeout = (shape: ReviewShape): MemberResult => ({ shape, result: { kind: "timeout" } });

describe("aggregate table", () => {
  it.each([
    { name: "unanimous MERGE", plan: G10, results: [merge("correctness"), merge("adversary")], outcome: "MERGE", dissent: [], g10: true },
    { name: "one block", plan: plan("standard"), results: [fixFirst("correctness", "src/gate.ts:2 is wrong")], outcome: "FIX_FIRST", dissent: ["correctness"], g10: false },
    { name: "a split", plan: G10, results: [merge("correctness"), fixFirst("adversary", "empty list read as allowed")], outcome: "FIX_FIRST", dissent: ["adversary"], g10: false },
    { name: "a missing member", plan: G10, results: [merge("correctness")], outcome: "no-verdict", dissent: [], g10: false },
    { name: "a member with no verdict", plan: G10, results: [merge("correctness"), none("adversary")], outcome: "no-verdict", dissent: [], g10: false },
    { name: "a member that timed out", plan: G10, results: [merge("correctness"), timeout("adversary")], outcome: "timeout", dissent: [], g10: false },
    { name: "a degraded member", plan: plan("g10", ["authority"], false), results: [merge("correctness"), merge("adversary")], outcome: "MERGE", dissent: [], g10: false },
    {
      name: "a member degraded at spawn",
      plan: G10,
      results: [{ ...merge("correctness"), degraded: true }, merge("adversary")],
      outcome: "MERGE",
      dissent: [],
      g10: false,
    },
  ])("$name: $outcome", ({ plan: panel, results, outcome, dissent, g10 }) => {
    const verdict = aggregate(panel, results, input);
    expect(verdict.outcome).toBe(outcome);
    expect(verdict.dissent).toEqual(dissent);
    expect(verdict.satisfiesG10).toBe(g10);
    expect(verdict.head).toBe(HEAD);
  });
});

describe("aggregate fails closed", () => {
  it.each([["fix_first"], ["FIX_FIRST "], ["WAIT"], ["Fix-First"], ["merge"], ["MERGE "], [undefined], [null]])(
    "reads a verdict of %j at the head as missing, never MERGE",
    (verdict) => {
      const odd = stored({ shape: "adversary", result: { kind: "verdict", head: HEAD, locator, reviewer, verdict } });
      const result = aggregate(G10, [merge("correctness"), odd], input);
      expect(result.outcome).toBe("no-verdict");
      expect(result.satisfiesG10).toBe(false);
    },
  );

  it("reads a verdict result with no verdict field as missing", () => {
    const bare = stored({ shape: "adversary", result: { kind: "verdict", head: HEAD, locator, reviewer } });
    expect(aggregate(G10, [merge("correctness"), bare], input).outcome).toBe("no-verdict");
  });

  it("reads an unknown result kind as missing", () => {
    const odd = stored({ shape: "adversary", result: { kind: "VERDICT", head: HEAD, verdict: "MERGE" } });
    expect(aggregate(G10, [merge("correctness"), odd], input).outcome).toBe("no-verdict");
  });

  it("never reads a MERGE at another head as a MERGE at this one", () => {
    expect(aggregate(G10, [merge("correctness"), merge("adversary", OLD_HEAD)], input).outcome).toBe("no-verdict");
  });

  it("ignores a FIX_FIRST at another head, which leaves the member missing", () => {
    const stale: MemberResult = { ...fixFirst("adversary", "old"), result: { kind: "verdict", head: OLD_HEAD, locator, reviewer, verdict: "FIX_FIRST", text: "old" } };
    expect(aggregate(G10, [merge("correctness"), stale], input).outcome).toBe("no-verdict");
  });

  it("is no-verdict for a plan with no blocking member", () => {
    const advisoryOnly: PanelPlan = { ...G10, members: G10.members.map((m) => ({ ...m, blocking: false })) };
    expect(aggregate(advisoryOnly, [merge("correctness"), merge("adversary")], input).outcome).toBe("no-verdict");
  });

  it("does not count a result from a shape the plan has no member for", () => {
    expect(aggregate(plan("standard"), [none("correctness"), merge("adversary")], input).outcome).toBe("no-verdict");
  });

  it("blocks when any of a member's results is a FIX_FIRST", () => {
    expect(aggregate(plan("standard"), [merge("correctness"), fixFirst("correctness", "late finding")], input).outcome).toBe("FIX_FIRST");
  });

  it("reads a missing member with a timeout beside it as no-verdict", () => {
    expect(aggregate(G10, [timeout("correctness"), none("adversary")], input).outcome).toBe("no-verdict");
  });

  it("prefers a block over a missing member", () => {
    const verdict = aggregate(G10, [fixFirst("correctness", "broken"), none("adversary")], input);
    expect(verdict.outcome).toBe("FIX_FIRST");
    expect(verdict.dissent).toEqual(["correctness"]);
  });

  it("lets a degraded member's FIX_FIRST block", () => {
    const verdict = aggregate(plan("g10", ["authority"], false), [fixFirst("correctness", "broken"), merge("adversary")], input);
    expect(verdict.outcome).toBe("FIX_FIRST");
    expect(verdict.degraded).toEqual(["correctness"]);
  });
});

describe("aggregate advisory members", () => {
  const untested = plan("standard", ["untested"]);

  it("never blocks on an advisory FIX_FIRST and carries its cited finding as a comment", () => {
    const verdict = aggregate(untested, [merge("correctness"), fixFirst("tests", "src/gate.ts:3 has no error-path test")], input);
    expect(verdict.outcome).toBe("MERGE");
    expect(verdict.dissent).toEqual([]);
    expect(verdict.findings).toEqual([{ shape: "tests", text: "src/gate.ts:3 has no error-path test", blocking: false }]);
  });

  it("drops an advisory finding whose citation does not verify, and one with none", () => {
    const text = ["src/gate.ts:3 is fine to test", "src/gate.ts:40 is past the end", "src/missing.ts:1 is unreadable", "no citation at all"].join("\n\n");
    const verdict = aggregate(untested, [merge("correctness"), fixFirst("tests", text)], input);
    expect(verdict.findings).toEqual([{ shape: "tests", text: "src/gate.ts:3 is fine to test", blocking: false }]);
  });

  it("drops an advisory member whose findings are all unverifiable", () => {
    expect(aggregate(untested, [merge("correctness"), fixFirst("tests", "vague worry")], input).findings).toEqual([]);
  });

  it("splits list items into separate findings", () => {
    const text = "- src/gate.ts:1-2 reads oddly\n- src/nowhere.ts:9 is gone";
    const verdict = aggregate(untested, [merge("correctness"), fixFirst("tests", text)], input);
    expect(verdict.findings.map((f) => f.text)).toEqual(["- src/gate.ts:1-2 reads oddly"]);
  });

  it.each(["vacuous", "no-tests"])("makes the tests member block when fix-proof is %s", (fixProof) => {
    const verdict = aggregate(untested, [merge("correctness"), fixFirst("tests", "the test passes on base")], { ...input, fixProof });
    expect(verdict.outcome).toBe("FIX_FIRST");
    expect(verdict.dissent).toEqual(["tests"]);
    expect(verdict.findings).toEqual([{ shape: "tests", text: "the test passes on base", blocking: true }]);
  });

  it.each(["Vacuous", " NO-TESTS "])("reads fix-proof %j without regard to case or spaces", (fixProof) => {
    expect(aggregate(untested, [merge("correctness")], { ...input, fixProof }).outcome).toBe("no-verdict");
  });

  it("needs the tests member's MERGE when fix-proof made it blocking", () => {
    expect(aggregate(untested, [merge("correctness")], { ...input, fixProof: "vacuous" }).outcome).toBe("no-verdict");
    expect(aggregate(untested, [merge("correctness")], { ...input, fixProof: "reproduced" }).outcome).toBe("MERGE");
  });

  it.each([
    { name: "the default table", policy: PANEL },
    { name: "the default policy", policy: DEFAULT_PANEL_POLICY },
  ])("withholds MERGE under $name when fix-proof is bad and no tests member was planned", ({ policy }) => {
    const changed = ["src/gate.ts", "src/gate.test.ts"].map((path) => ({ path, additions: 5, deletions: 1 }));
    const planned = planPanel(classifyPr({ repo: "o/r", pr: 1, head: HEAD, base: OLD_HEAD, kind: "feature", changedFiles: changed }), policy, { opus: true });
    expect(planned.members.map((m) => m.shape)).not.toContain("tests");

    const verdicts = ["vacuous", "no-tests", "reproduced"].map((fixProof) => aggregate(planned, [merge("correctness")], { ...input, fixProof }).outcome);

    expect(verdicts).toEqual(["no-verdict", "no-verdict", "MERGE"]);
  });
});

describe("aggregate findings", () => {
  it("keeps a blocking finding with no verifiable citation", () => {
    const verdict = aggregate(plan("standard"), [fixFirst("correctness", "src/missing.ts:4 is absent, and nothing guards it")], input);
    expect(verdict.findings).toEqual([{ shape: "correctness", text: "src/missing.ts:4 is absent, and nothing guards it", blocking: true }]);
  });

  it("orders findings by shape and labels each with its member", () => {
    const panel = plan("g10", ["authority", "untested"]);
    const verdict = aggregate(panel, [fixFirst("tests", "src/gate.ts:1 untested"), fixFirst("adversary", "bypass"), fixFirst("correctness", "wrong")], input);
    expect(verdict.findings.map((f) => f.shape)).toEqual(["correctness", "adversary", "tests"]);
  });

  it("bounds the findings per member so one long member does not crowd out another", () => {
    const long = "x".repeat(MAX_FIX_FIRST_TEXT_CHARS);
    const verdict = aggregate(G10, [fixFirst("correctness", `${long}\ncorrectness tail`), fixFirst("adversary", `${long}\nadversary tail`)], input);
    expect(verdict.findings.map((f) => f.shape)).toEqual(["correctness", "adversary"]);
    for (const finding of verdict.findings) expect(finding.text.length).toBeLessThanOrEqual(MAX_FIX_FIRST_TEXT_CHARS / 2);
    expect(verdict.findings.map((f) => f.text.endsWith("tail"))).toEqual([true, true]);
    expect(verdict.findings.reduce((sum, f) => sum + f.text.length, 0)).toBeLessThanOrEqual(MAX_FIX_FIRST_TEXT_CHARS);
  });

  it("keeps a long blocking finding's first citation when the bound cuts its start", () => {
    const text = `src/gate.ts:2 lets an empty list through\n${"x".repeat(MAX_FIX_FIRST_TEXT_CHARS)}\nlatest restatement`;
    const [finding] = aggregate(plan("standard"), [fixFirst("correctness", text)], input).findings;
    expect(finding?.text.startsWith("src/gate.ts:2 lets an empty list through\n")).toBe(true);
    expect(finding?.text.endsWith("latest restatement")).toBe(true);
    expect(finding?.text.length).toBeLessThanOrEqual(MAX_FIX_FIRST_TEXT_CHARS);
  });

  it("takes the closer and defect class from the dissenting members", () => {
    const verdict = aggregate(G10, [merge("correctness"), fixFirst("adversary", "Defect class: fail-open\nempty list allowed", "no")], input);
    expect(verdict.closer).toBe("no");
    expect(verdict.defectClass).toBe("fail-open");
  });

  it("reads closer no when any dissenter says no", () => {
    const verdict = aggregate(G10, [fixFirst("correctness", "a", "yes"), fixFirst("adversary", "b", "no")], input);
    expect(verdict.closer).toBe("no");
  });

  it("has no findings, closer or dissent on a clean MERGE", () => {
    const verdict = aggregate(G10, [merge("correctness"), merge("adversary")], input);
    expect(verdict).toEqual({ outcome: "MERGE", head: HEAD, findings: [], dissent: [], degraded: [], satisfiesG10: true });
  });
});

describe("aggregate satisfiesG10", () => {
  it("is false for a standard panel", () => {
    expect(aggregate(plan("standard"), [merge("correctness")], input).satisfiesG10).toBe(false);
  });

  it("is false for a g10 panel without an adversary", () => {
    expect(aggregate(plan("g10", ["large"], true, DEFAULT_PANEL_POLICY), [merge("correctness")], input).satisfiesG10).toBe(false);
  });

  it("is false when the correctness member is not an opus profile", () => {
    const sonnetOnly: PanelPolicy = { ...PANEL, roles: { g10: "reviewer", standard: "reviewer" } };
    const verdict = aggregate(plan("g10", ["authority"], true, sonnetOnly), [merge("correctness"), merge("adversary")], input);
    expect(verdict.outcome).toBe("MERGE");
    expect(verdict.satisfiesG10).toBe(false);
  });

  it("reads opus profiles from the caller's sonnetFor table", () => {
    const custom: PanelPolicy = { ...PANEL, roles: { g10: "deep-reviewer", standard: "reviewer" }, sonnetFor: { "deep-reviewer": "reviewer" } };
    const verdict = aggregate(plan("g10", ["authority"], true, custom), [merge("correctness"), merge("adversary")], { ...input, sonnetFor: custom.sonnetFor });
    expect(verdict.satisfiesG10).toBe(true);
  });

  it("lists every degraded member in shape order", () => {
    const verdict = aggregate(plan("g10", ["authority"], false), [merge("correctness"), { ...merge("adversary"), degraded: true }], input);
    expect(verdict.degraded).toEqual(["correctness", "adversary"]);
  });
});
