import { describe, expect, it } from "vitest";
import { bulkSignal } from "./bulk.js";
import { LedgerRowSchema, type LedgerRowWire } from "./ledger.js";

function row(fields: Partial<LedgerRowWire>): LedgerRowWire {
  return {
    key: "morning:2026-10-04:ex-1",
    v: 2,
    source: "morning",
    asked_at: null,
    initiative: "widgets",
    header: null,
    question: "Plan questions for the widget rollout",
    options: [],
    recommended: null,
    answer: null,
    ...fields,
  };
}

/** Every way an owner adopts a phrase: the label as written, the label with "ok", or typed after another label. */
function adoptions(phrase: string) {
  return [
    { recommended: phrase, answer: phrase, covers: null },
    { recommended: `${phrase} (Recommended)`, answer: "ok", covers: null },
    { recommended: "Ship it", answer: `Ship it; ${phrase}`, covers: null },
    { recommended: null, answer: phrase, covers: null },
  ];
}

describe("bulkSignal on the worked examples", () => {
  it.each([
    ["Recommend 'ok ZZ-343 defaults' (6 Qs in the ZZ-343 plan)", { covers: 6, reason: "plural-defaults" }],
    ["19 plan questions: accept all recommended answers (ZD-3 s7, ZD-1 D1-D4)", { covers: null, reason: "plural-defaults" }],
    ["accept the 9 defaults of the ZZ-695 decider plan", { covers: 9, reason: "plural-defaults" }],
    ["All nine section 9 defaults accepted", { covers: 9, reason: "plural-defaults" }],
  ])("reads %j as the same batch wherever the owner adopts it", (phrase, expected) => {
    for (const input of adoptions(phrase)) expect(bulkSignal(input)).toEqual(expected);
  });
});

describe("bulkSignal on every wording of a batch acceptance", () => {
  it.each([
    ["yes to all defaults", null],
    ["yes to all the defaults", null],
    ["yes to all recommended answers", null],
    ["ok with all defaults", null],
    ["ok for all defaults", null],
    ["accept all the defaults", null],
    ["yes, all defaults", null],
    ["ok to all 6 defaults", 6],
    ["accepted all 6 recommendations", 6],
    ["Approved all nine defaults", 9],
    ["accepts every recommendation as written", null],
    ["accept all 3 recommendations, only change naming", 3],
    ["all as written", null],
    ["ok, all as written", null],
    ["yes, all as recommended", null],
  ])("reads %j as plural defaults wherever the owner adopts it", (phrase, covers) => {
    for (const input of adoptions(phrase)) expect(bulkSignal(input)).toEqual({ covers, reason: "plural-defaults" });
  });
});

describe("bulkSignal signals", () => {
  it("trusts a source that says one answer covered several items", () => {
    expect(bulkSignal({ recommended: "Retry once", answer: "Retry once", covers: 3 })).toEqual({
      covers: 3,
      reason: "multi-item",
    });
  });

  it.each([
    ["accept Q1 to Q7 as proposed", 7],
    ["yes to Q1-Q5", 5],
    ["go with D2 to D7", 6],
    ["ok, questions 1-10 are fine", 10],
    ["ok, the fourteen plans", 14],
    ["okayed all 4 questions", 4],
  ])("reads the range or count in %j wherever the owner adopts it", (phrase, covers) => {
    for (const input of adoptions(phrase)) expect(bulkSignal(input)?.covers).toBe(covers);
  });

  it("reads a batch the owner adds after the recommendation", () => {
    const signal = bulkSignal({ recommended: "Retry once", answer: "Retry once, and accept the 4 plan defaults", covers: null });

    expect(signal).toEqual({ covers: 4, reason: "plural-defaults" });
  });

  it.each([
    "I don't accept all recommended answers",
    "not ok to go with all defaults",
    "All nine defaults not accepted",
    "Approve all defaults? no",
    "Accept all as written in the doc for Q2 only",
    "Recommend all defaults be reviewed",
  ])("finds nothing in the negated, questioned or scoped %j wherever the owner adopts it", (phrase) => {
    for (const input of adoptions(phrase)) expect(bulkSignal(input)).toBeNull();
  });

  it.each([
    "Target Q4-2026 for launch",
    "Ship in Q3-Q4",
    "Use D1 to 5 retries",
    "Run 3 plans in parallel",
    "Cap at 2 questions per page",
    "Proceed by splitting into two decisions",
    "Keep the defaults",
    "Drop all defaults and require explicit config",
    "ok, run 3 plans in parallel",
    "ok, cap at 2 questions per page",
    "accept a 2026 defaults review",
    "Keep 10 questions per page",
    "Keep three plans running",
    "Keep Q1-Q4 reporting",
    "Take 2 decisions per batch",
    "Keep all defaults",
    "Keep the UTF-8 defaults",
    "accept UTF-8 defaults",
    "Approve PR-12 recommendations",
    "accept 10 questions per page",
  ])("finds nothing in the single decision %j wherever the owner adopts it", (phrase) => {
    for (const input of adoptions(phrase)) expect(bulkSignal(input)).toBeNull();
  });

  it("finds nothing in one value applied everywhere", () => {
    const signal = bulkSignal({
      recommended: "Raise the ceiling to 100% across the board",
      answer: "Raise the ceiling to 100% across the board",
      covers: null,
    });

    expect(signal).toBeNull();
  });

  it("finds nothing in a label with the singular 'default'", () => {
    expect(bulkSignal({ recommended: "`default` EffortLossSource", answer: "ok, keep the default", covers: 1 })).toBeNull();
  });
});

describe("LedgerRowSchema applying the bulk rule", () => {
  it("demotes a recommended pick of a quoted batch reply with the count it read", () => {
    const label = "Recommend 'ok ZZ-343 defaults' (6 Qs in the ZZ-343 plan)";
    const parsed = LedgerRowSchema.parse(row({ recommended: label, answer: "ok", pick_type: "recommended" }));

    expect(parsed).toMatchObject({ outcome: "bulk", covers: 6, bulk_from: { outcome: "accept", covers: null } });
  });

  it("demotes a recommended pick of a plain defaults batch", () => {
    const label = "accept the 9 defaults of the ZZ-695 decider plan";
    const parsed = LedgerRowSchema.parse(row({ recommended: label, answer: "yes", pick_type: "recommended" }));

    expect(parsed).toMatchObject({ outcome: "bulk", covers: 9 });
  });

  it.each(["Keep 10 questions per page", "Keep Q1-Q4 reporting", "Keep all defaults"])(
    "keeps %j as accept when picked and as amend when typed after another label",
    (phrase) => {
      const options = [{ label: `${phrase} (Recommended)` }, { label: "Hold" }];
      const picked = LedgerRowSchema.parse(row({ options, recommended: options[0]?.label ?? null, answer: phrase }));
      const typed = LedgerRowSchema.parse(row({ recommended: "Ship it", answer: `Ship it, and ${phrase.toLowerCase()}` }));

      expect(picked).toMatchObject({ outcome: "accept", covers: null });
      expect(typed).toMatchObject({ outcome: "amend", covers: null });
    },
  );

  it("demotes an explicit accept from a source that counted several ids", () => {
    const parsed = LedgerRowSchema.parse(row({ recommended: "Retry once", answer: "ok", outcome: "accept", covers: 4 }));

    expect(parsed).toMatchObject({ outcome: "bulk", covers: 4 });
  });

  it("demotes an amend to bulk", () => {
    const parsed = LedgerRowSchema.parse(
      row({ recommended: "Ship today", answer: "Ship today, and accept all plan defaults", options: [{ label: "Ship today" }] }),
    );

    expect(parsed.outcome).toBe("bulk");
  });

  it("gives the same row on re-read", () => {
    const first = LedgerRowSchema.parse(row({ recommended: "Retry once", answer: "Retry once; accept the 9 defaults" }));
    const second = LedgerRowSchema.parse(first);

    expect(second).toEqual(first);
    expect(second).toMatchObject({ outcome: "bulk", covers: 9 });
  });

  it("re-applies the rule on re-read, so a stored demotion is never final", () => {
    const stored = { ...row({ recommended: "Keep the defaults", answer: "Keep the defaults" }), outcome: "bulk" as const, covers: 6 };
    const parsed = LedgerRowSchema.parse({ ...stored, bulk_from: { outcome: "accept", covers: null } });

    expect(parsed).toMatchObject({ outcome: "accept", covers: null, bulk_from: null });
  });

  it("keeps a bulk outcome the source stated", () => {
    const parsed = LedgerRowSchema.parse(row({ recommended: "Retry once", answer: "Retry once", outcome: "bulk", covers: 2 }));

    expect(parsed).toMatchObject({ outcome: "bulk", covers: 2, bulk_from: null });
  });

  it("keeps one value applied everywhere as accept", () => {
    const label = "Raise the ceiling to 100% across the board";
    const parsed = LedgerRowSchema.parse(row({ recommended: label, answer: label, options: [{ label }, { label: "Keep it" }] }));

    expect(parsed).toMatchObject({ outcome: "accept", covers: null });
  });

  it("keeps an accepted 'Keep the defaults' option as accept", () => {
    const options = [{ label: "Keep the defaults (Recommended)" }, { label: "Tighten retries" }];
    const parsed = LedgerRowSchema.parse(row({ options, recommended: options[0]?.label ?? null, answer: "Keep the defaults" }));

    expect(parsed.outcome).toBe("accept");
  });

  it("keeps a singular 'default' label as accept", () => {
    const options = [{ label: "`default` EffortLossSource (Recommended)" }, { label: "`strict` EffortLossSource" }];
    const parsed = LedgerRowSchema.parse(row({ options, recommended: options[0]?.label ?? null, answer: "`default` EffortLossSource" }));

    expect(parsed.outcome).toBe("accept");
  });

  it("keeps a multi-select of listed labels as other", () => {
    const options = [{ label: "Keep the defaults (Recommended)" }, { label: "Tighten retries" }, { label: "Add alerts" }];
    const parsed = LedgerRowSchema.parse(row({ options, recommended: options[0]?.label ?? null, answer: "Tighten retries, Add alerts" }));

    expect(parsed).toMatchObject({ outcome: "other", covers: null });
  });

  it("keeps a 'NOT accepted' carve-out as redirect", () => {
    const parsed = LedgerRowSchema.parse(
      row({ recommended: "Accept the 5 defaults", answer: "NOT accepted: ZZ-276 C5 needs its own review" }),
    );

    expect(parsed).toMatchObject({ outcome: "redirect", covers: null });
  });

  it.each(["other", "redirect", "none", null] as const)("never changes an explicit %s outcome", (outcome) => {
    const parsed = LedgerRowSchema.parse(row({ recommended: "accept the 9 defaults", answer: "ok", outcome, covers: 9 }));

    expect(parsed.outcome).toBe(outcome);
  });
});
