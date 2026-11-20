import { describe, expect, it } from "vitest";
import { byRecDecision, byRecSubjectOfItem } from "./by-rec.js";
import { BY_REC_FLOOR, isGuardPath, type ByRecSubject } from "./by-rec-floor.js";
import { BY_REC_RESOLVER, byRecPolicySchema, byRecRowSchema, type ByRecPolicy } from "./by-rec-schema.js";
import type { OwnerItem } from "./schema.js";
import { item } from "./test-fixtures.js";

const OPENED = "2026-03-01T00:00:00.000Z";
const HOUR = 3_600_000;
const after = (ms: number): Date => new Date(Date.parse(OPENED) + ms);

function policy(overrides: Partial<ByRecPolicy> = {}): ByRecPolicy {
  return byRecPolicySchema.parse({ schema: "titan/auto-by-rec-policy@1", mode: "live", ...overrides });
}

function subject(overrides: Partial<ByRecSubject> = {}): ByRecSubject {
  return {
    source: "deposit",
    id: "deposit:example",
    openedAt: OPENED,
    recommendation: { answer: "a", by: "example-seat", rationale: "A keeps the cap" },
    kind: "decide",
    door: "two-way",
    options: ["a", "b"],
    ...overrides,
  };
}

const FLOOR_CASES: [string, Partial<ByRecSubject>][] = [
  ["closed", { closed: true }],
  ["no-recommendation", { recommendation: undefined }],
  ["g10-hold", { holdClasses: ["g10-adversary"] }],
  ["g10-hold", { holdClasses: ["g10-some-future-class"] }],
  ["security-class", { decisionClass: "D1" }],
  ["guard-class", { decisionClass: "D21" }],
  ["owner-at-head", { ownerAtHead: ["files-unread"] }],
  ["owner-at-head", { holdClasses: ["skill-path"] }],
  ["guard-path", { paths: ["packages/authority/src/table.json"] }],
  ["guard-path", { guardPath: true }],
  ["release", { headRef: "changeset-release/main" }],
  ["release", { category: "Release" }],
  ["release", { authorityRows: ["REL-1"] }],
  ["publish", { authorityRows: ["PUB-PRIV"] }],
  ["publish", { authorityRows: ["EXT-POST"] }],
  ["secret", { authorityRows: ["SEC-READ"] }],
  ["hardware", { authorityRows: ["HW-ACT"] }],
  ["money", { category: "spend" }],
  ["money", { text: ["Upgrade the plan for $ 40 a month"] }],
  ["one-way", { door: "one-way" }],
  ["irreversible", { irreversible: true }],
  ["on-silence-wait", { onSilence: { action: "wait" } }],
  ["on-silence-expire", { onSilence: { action: "expire", afterHours: 6 } }],
  ["blind", { blind: true }],
  ["change-requested", { changeRequested: true }],
  ["personal", { personal: true }],
  ["not-a-decision", { kind: "do" }],
  ["not-a-decision", { kind: "sitting" }],
  ["operator-audience", { audience: "operator" }],
  ["owner-op", { op: "merge-at-head" }],
  ["ship", { ship: true }],
  ["plan-approval", { planApproval: true }],
  ["answer-unsound", { options: ["b", "c"] }],
  ["answer-unsound", { default: "b" }],
];

describe("byRecDecision floor", () => {
  it.each(FLOOR_CASES)("refuses %s long after the wait, under the most permissive policy", (reason, overrides) => {
    const permissive = policy({ afterHours: 1, exclude: [] });

    const decision = byRecDecision(subject(overrides), after(720 * HOUR), permissive);

    expect(decision).toEqual({ eligible: false, reason: `floor:${reason}` });
  });

  it("has a case for every floor class", () => {
    expect(new Set(FLOOR_CASES.map(([reason]) => reason))).toEqual(new Set(BY_REC_FLOOR.map(([reason]) => reason)));
  });

  it.each([
    ["an allow list", { allow: ["g10"] }],
    ["a floor override", { floor: [] }],
    ["an unknown exclusion field", { exclude: [{ field: "anything", value: "g10" }] }],
  ])("refuses a policy file carrying %s", (_label, extra) => {
    const parsed = byRecPolicySchema.safeParse({ schema: "titan/auto-by-rec-policy@1", mode: "live", ...extra });

    expect(parsed.success).toBe(false);
  });
});

describe("byRecDecision clock", () => {
  it("is not eligible at 23 h 59 m and says when it will be", () => {
    const decision = byRecDecision(subject(), after(24 * HOUR - 60_000), policy());

    expect(decision).toEqual({ eligible: false, reason: "too-early", at: "2026-03-02T00:00:00.000Z" });
  });

  it("is eligible at 24 h with the recommended answer and its rationale", () => {
    const decision = byRecDecision(subject(), after(24 * HOUR), policy());

    expect(decision).toEqual({ eligible: true, at: "2026-03-02T00:00:00.000Z", answer: "a", rationale: "A keeps the cap" });
  });

  it("fires an apply-default 6 h deposit at 6 h, not before", () => {
    const sixHours = subject({ onSilence: { action: "apply-default", afterHours: 6 }, default: "a" });

    expect(byRecDecision(sixHours, after(6 * HOUR - 1), policy()).eligible).toBe(false);
    expect(byRecDecision(sixHours, after(6 * HOUR), policy())).toMatchObject({ eligible: true, answer: "a" });
  });

  it("never fires an onSilence wait item", () => {
    const decision = byRecDecision(subject({ onSilence: { action: "wait" } }), after(10_000 * HOUR), policy());

    expect(decision).toEqual({ eligible: false, reason: "floor:on-silence-wait" });
  });

  it("refuses an unreadable open time", () => {
    expect(byRecDecision(subject({ openedAt: "yesterday" }), after(48 * HOUR), policy())).toEqual({ eligible: false, reason: "bad-opened-at" });
  });

  it("names the recommender when no rationale was given", () => {
    const decision = byRecDecision(subject({ recommendation: { answer: "a", by: "example-seat" } }), after(24 * HOUR), policy());

    expect(decision).toMatchObject({ eligible: true, rationale: "recommended by example-seat" });
  });
});

describe("byRecDecision policy file", () => {
  it("decides nothing in mode off", () => {
    expect(byRecDecision(subject(), after(48 * HOUR), policy({ mode: "off" }))).toEqual({ eligible: false, reason: "mode-off" });
  });

  it("decides the same in shadow as in live", () => {
    expect(byRecDecision(subject(), after(48 * HOUR), policy({ mode: "shadow" }))).toMatchObject({ eligible: true });
  });

  it.each([
    [{ field: "source", value: "deposit" }, {}],
    [{ field: "class", value: "D5" }, { decisionClass: "D5" }],
    [{ field: "hold", value: "owner" }, { holdClasses: ["owner-asked"] }],
    [{ field: "path", value: "apps/console/" }, { paths: ["apps/console/web/x.ts"] }],
    [{ field: "by", value: "example-seat" }, {}],
  ] as const)("adds the exclusion %o", (rule, overrides) => {
    const decision = byRecDecision(subject(overrides), after(48 * HOUR), policy({ exclude: [rule] }));

    expect(decision).toEqual({ eligible: false, reason: `excluded:${rule.field}=${rule.value}` });
  });

  it("matches an exact-field exclusion exactly, not by prefix", () => {
    const decision = byRecDecision(subject({ decisionClass: "D50" }), after(48 * HOUR), policy({ exclude: [{ field: "class", value: "D5" }] }));

    expect(decision.eligible).toBe(true);
  });

  it("holds a recommendation below the owner's confidence floor", () => {
    const low = subject({ recommendation: { answer: "a", by: "example-seat", confidence: 0.4 } });

    expect(byRecDecision(low, after(48 * HOUR), policy({ minConfidence: 0.5 }))).toEqual({ eligible: false, reason: "below-confidence" });
    expect(byRecDecision(subject(), after(48 * HOUR), policy({ minConfidence: 0.5 }))).toEqual({ eligible: false, reason: "below-confidence" });
  });

  it("defaults a bare file to shadow, 24 h and no exclusions", () => {
    expect(byRecPolicySchema.parse({ schema: "titan/auto-by-rec-policy@1" })).toEqual({ schema: "titan/auto-by-rec-policy@1", mode: "shadow", afterHours: 24, exclude: [] });
  });
});

describe("isGuardPath", () => {
  it.each([
    ["packages/authority/src/table.json", true],
    ["products/factory/src/shepherd/g10-class-rules.ts", true],
    ["products/factory/src/shepherd/registration-hold.ts", true],
    ["products/factory/src/shepherd/hold-reason.ts", true],
    ["packages/owner-queue/src/by-rec-floor.ts", true],
    [".codewatch/merge-policy.json", true],
    ["packages/metrics/src/threshold.ts", false],
    ["apps/console/web/inbox.tsx", false],
  ])("reads %s as guard: %s", (path, guard) => {
    expect(isGuardPath(path)).toBe(guard);
  });
});

describe("byRecSubjectOfItem", () => {
  const deposit = item({
    id: "deposit:example",
    openedAt: OPENED,
    options: [{ id: "a", label: "Keep the cap" }, { id: "b", label: "Raise the cap" }],
    recommended: { optionId: "a", by: "example-seat", rationale: "smaller queue" },
  });

  it("makes an open deposit with a recommendation eligible after 24 h", () => {
    expect(byRecDecision(byRecSubjectOfItem(deposit), after(24 * HOUR), policy())).toEqual({
      eligible: true,
      at: "2026-03-02T00:00:00.000Z",
      answer: "a",
      rationale: "smaller queue",
    });
  });

  it.each<[string, Partial<OwnerItem>]>([
    ["closed", { status: "answered" }],
    ["blind", { recommended: { optionId: "a", by: "example-seat", hidden: true } }],
    ["owner-op", { op: { kind: "close-pr", repo: "example-org/example-repo", pr: 1, headSha: "a".repeat(40) } }],
    ["money", { context: "This costs $120 a year" }],
    ["ship", { kind: "approve", sources: [{ system: "round", ref: "r1#q1" }] }],
    ["irreversible", { irreversible: "Deletes the archive" }],
  ])("carries the %s floor over from the item", (reason, overrides) => {
    const decision = byRecDecision(byRecSubjectOfItem({ ...deposit, ...overrides }), after(48 * HOUR), policy());

    expect(decision).toEqual({ eligible: false, reason: `floor:${reason}` });
  });
});

describe("byRecRowSchema", () => {
  it("round-trips a log row", () => {
    const row = {
      schema: "titan/auto-by-rec@1",
      subject: { source: "gate", id: "gate:example", summary: "Merge example-org/example-repo#7" },
      recommendation: { answer: "merge", by: "example-reviewer", rationale: "MERGE at head, CI green", confidence: 0.9 },
      openedAt: OPENED,
      resolvedAt: "2026-03-02T00:05:00.000Z",
      facts: { head: "a".repeat(40), checks: ["build", "test"], green: true },
      mode: "shadow",
      result: "would-resolve",
      resolver: BY_REC_RESOLVER,
    };

    expect(byRecRowSchema.parse(JSON.parse(JSON.stringify(row)))).toEqual(row);
  });

  it("refuses a row attributed to anyone but auto-by-rec", () => {
    const parsed = byRecRowSchema.safeParse({ resolver: { class: "owner", id: "owner" } });

    expect(parsed.success).toBe(false);
  });
});
