import { RoundSchema } from "@titan-design/review-schema";
import { describe, expect, it } from "vitest";
import { buildOwnerRounds, type OwnerRoundOptions, type Principle } from "./rounds.js";
import type { OwnerItem } from "./schema.js";
import { item } from "./test-fixtures.js";

const base: OwnerRoundOptions = { unit: "owner-queue", storybookUrl: "http://127.0.0.1:6006" };

function decide(id: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
  return item({
    id,
    summary: `Pick a cache layout for service ${id}. Now: none`,
    options: [
      { id: "flat", label: "Flat", description: "one table per entity" },
      { id: "nested", label: "Nested", description: "one document per tree" },
    ],
    category: "tech_design",
    ...overrides,
  });
}

const recommended = { optionId: "flat", by: "decider", confidence: 0.8, rationale: "Reads stay one hop" };

function expectValid(manifests: unknown[]): void {
  for (const manifest of manifests) {
    const result = RoundSchema.safeParse(manifest);
    expect(result.error?.issues ?? []).toEqual([]);
  }
}

describe("buildOwnerRounds", () => {
  it("asks each open Decide item in input order, one section per question", () => {
    const { rounds } = buildOwnerRounds([decide("b"), decide("a"), decide("c")], base);

    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.bindings.map((each) => each.itemIds)).toEqual([["b"], ["a"], ["c"]]);
    expect(rounds[0]!.manifest.sections!.map((each) => each.questionIds)).toEqual([["q1"], ["q2"], ["q3"]]);
    expectValid(rounds.map((each) => each.manifest));
  });

  it("puts shadow categories in an after-answer round and graduated ones in a shown round", () => {
    const items = [
      decide("shadow-1", { recommended }),
      decide("graduated-1", { category: "naming", recommended }),
      decide("uncategorised", { category: undefined, recommended }),
      decide("hidden", { category: "naming", recommended: { ...recommended, hidden: true } }),
    ];

    const { rounds } = buildOwnerRounds(items, { ...base, graduated: ["naming"] });

    expect(rounds.map((each) => [each.manifest.recommendations, each.bindings.flatMap((b) => b.itemIds)])).toEqual([
      ["after-answer", ["shadow-1", "uncategorised", "hidden"]],
      ["shown", ["graduated-1"]],
    ]);
    expect(rounds.map((each) => each.manifest.round)).toEqual([1, 2]);
    expectValid(rounds.map((each) => each.manifest));
  });

  it("treats every category as shadow until one is graduated", () => {
    const { rounds } = buildOwnerRounds([decide("a", { category: "naming" })], base);

    expect(rounds.map((each) => each.manifest.recommendations)).toEqual(["after-answer"]);
  });

  it("carries the decider's pick as the recommendation, named by its shown label", () => {
    const { rounds } = buildOwnerRounds([decide("a", { recommended })], base);
    const question = rounds[0]!.manifest.questions[0]!;

    expect(question).toMatchObject({
      kind: "pick-one",
      options: ["Flat: one table per entity", "Nested: one document per tree"],
      recommendation: { answer: "Flat: one table per entity", confidence: 0.8, by: "decider", rationale: "Reads stay one hop" },
    });
    expect(rounds[0]!.bindings[0]!.options).toEqual({ "Flat: one table per entity": "flat", "Nested: one document per tree": "nested" });
  });

  it("drops a recommendation round@2 cannot carry: no confidence, or neither rationale nor cite", () => {
    const items = [
      decide("no-confidence", { recommended: { optionId: "flat", by: "decider", rationale: "r" } }),
      decide("no-rationale", { recommended: { optionId: "flat", by: "decider", confidence: 0.5 } }),
      decide("cite-only", { recommended: { optionId: "flat", by: "decider", confidence: 0.5, cite: "ledger:k-1" } }),
    ];

    const questions = buildOwnerRounds(items, base).rounds[0]!.manifest.questions;

    expect(questions.map((each) => ("recommendation" in each ? each.recommendation?.rationale : undefined))).toEqual([
      undefined,
      undefined,
      "Cite: ledger:k-1",
    ]);
    expectValid([buildOwnerRounds(items, base).rounds[0]!.manifest]);
  });

  it("asks the items a principle covers as one Principle: question listing each", () => {
    const principle: Principle = {
      id: "layout-is-planner-call",
      rule: "The planner settles a cache layout itself when no reader sees the difference.",
      covers: ["a", "c"],
      recommended: { optionId: "yes", by: "decider", confidence: 0.7, rationale: "Same reason for both" },
    };

    const { rounds } = buildOwnerRounds([decide("a"), decide("b"), decide("c")], { ...base, principles: [principle] });
    const [first, second] = rounds[0]!.manifest.questions;

    expect(first!.prompt).toMatch(/^Principle: The planner settles .* It covers: \(1\) .*service a.*; \(2\) .*service c/);
    expect(first).toMatchObject({ recommendation: { answer: expect.stringMatching(/^Yes/) } });
    expect(second!.prompt).toContain("service b");
    expect(rounds[0]!.bindings[0]).toMatchObject({ itemIds: ["a", "c"], principleId: "layout-is-planner-call" });
    expect(Object.values(rounds[0]!.bindings[0]!.options)).toEqual(["yes", "no"]);
    expectValid(rounds.map((each) => each.manifest));
  });

  it("never batches a one-way item, and drops a principle left with fewer than two items", () => {
    const principle: Principle = { id: "p", rule: "One rule for both.", covers: ["a", "b"] };

    const { rounds } = buildOwnerRounds([decide("a", { door: "one-way" }), decide("b")], { ...base, principles: [principle] });

    expect(rounds[0]!.bindings.map((each) => [each.itemIds, each.principleId])).toEqual([
      [["a"], undefined],
      [["b"], undefined],
    ]);
  });

  it("gives an item to the first principle that covers it", () => {
    const principles: Principle[] = [
      { id: "first", rule: "First rule.", covers: ["a", "b"] },
      { id: "second", rule: "Second rule.", covers: ["b", "c", "d"] },
    ];

    const { rounds } = buildOwnerRounds(["a", "b", "c", "d"].map((id) => decide(id)), { ...base, principles });

    expect(rounds[0]!.bindings.map((each) => [each.principleId, each.itemIds])).toEqual([
      ["first", ["a", "b"]],
      ["second", ["c", "d"]],
    ]);
    expectValid(rounds.map((each) => each.manifest));
  });

  it("starts a new round past maxQuestions, counting a principle as one question", () => {
    const principle: Principle = { id: "p", rule: "One rule.", covers: ["a", "b"] };
    const items = ["a", "b", "c", "d"].map((id) => decide(id));

    const { rounds } = buildOwnerRounds(items, { ...base, principles: [principle], maxQuestions: 2, firstRound: 4 });

    expect(rounds.map((each) => [each.manifest.round, each.bindings.map((b) => b.itemIds)])).toEqual([
      [4, [["a", "b"], ["c"]]],
      [5, [["d"]]],
    ]);
    expectValid(rounds.map((each) => each.manifest));
  });

  it("asks an item with no options as a text question", () => {
    const { rounds } = buildOwnerRounds([decide("a", { options: undefined })], base);

    expect(rounds[0]!.manifest.questions[0]).toEqual({ id: "q1", kind: "text", prompt: decide("a").summary });
    expectValid(rounds.map((each) => each.manifest));
  });

  it("keeps the round valid when options repeat across questions or read as a blanket sign-off", () => {
    const yesNo = [
      { id: "approve", label: "Approve" },
      { id: "no", label: "No" },
    ];
    const items = [decide("a", { options: yesNo, recommended: { ...recommended, optionId: "no" } }), decide("b", { options: yesNo, summary: "LGTM" })];

    const { rounds } = buildOwnerRounds(items, base);

    expect(rounds[0]!.bindings.map((each) => each.options)).toEqual([
      { "Approve (q1)": "approve", No: "no" },
      { "Approve (q2)": "approve", "No (q2)": "no" },
    ]);
    expectValid(rounds.map((each) => each.manifest));
  });

  it("keeps a text question valid when its summary reads as a blanket sign-off", () => {
    const { rounds } = buildOwnerRounds([decide("a", { options: undefined, summary: "LGTM" })], base);

    expect(rounds[0]!.manifest.questions[0]!.prompt).toBe("LGTM (q1)");
    expectValid(rounds.map((each) => each.manifest));
  });

  it("keeps every option when several render to the same label", () => {
    const same = ["x", "y", "z"].map((id) => ({ id, label: "Same" }));

    const { rounds } = buildOwnerRounds([decide("a", { options: same })], base);

    expect(rounds[0]!.bindings[0]!.options).toEqual({ Same: "x", "Same (q1)": "y", "Same (q1) (q1)": "z" });
    expectValid(rounds.map((each) => each.manifest));
  });

  it("asks a principle's items alone when its rule is blank", () => {
    const principle: Principle = { id: "p", rule: "  ", covers: ["a", "b"] };

    const { rounds } = buildOwnerRounds([decide("a"), decide("b")], { ...base, principles: [principle] });

    expect(rounds[0]!.bindings.map((each) => each.principleId)).toEqual([undefined, undefined]);
    expectValid(rounds.map((each) => each.manifest));
  });

  it("skips items that are not open Decide asks for the owner, with the reason", () => {
    const items = [
      decide("answered", { status: "answered" }),
      item({ id: "approval", kind: "approve" }),
      decide("decider", { route: { target: "decider", reason: "auto", shadow: false } }),
      decide("asked"),
    ];

    const { rounds, skipped } = buildOwnerRounds(items, base);

    expect(skipped).toEqual([
      { id: "answered", reason: "not-open" },
      { id: "approval", reason: "not-decide" },
      { id: "decider", reason: "routed-to-decider" },
    ]);
    expect(rounds.flatMap((each) => each.bindings.flatMap((b) => b.itemIds))).toEqual(["asked"]);
  });

  it("builds no round from an empty queue", () => {
    expect(buildOwnerRounds([], base)).toEqual({ rounds: [], skipped: [] });
  });
});
