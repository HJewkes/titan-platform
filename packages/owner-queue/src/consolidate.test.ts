import { describe, expect, it } from "vitest";
import { consolidate } from "./consolidate.js";
import type { OwnerAnswer, OwnerItem } from "./schema.js";
import { SHA_A, SHA_B, item } from "./test-fixtures.js";

const OWNER = { class: "owner", id: "owner", channel: "round" };
const OPTIONS = [
  { id: "keep", label: "Keep" },
  { id: "swap", label: "Swap" },
];

function at(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
}

function round(id: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
  return item({ id, sources: [{ system: "round", ref: id }], kind: "review", ...overrides });
}

function answered(base: OwnerItem, answer: Partial<OwnerAnswer>, day = 5): OwnerItem {
  return { ...base, status: "answered", answer: { by: OWNER, at: at(day), ...answer } };
}

function ids(items: readonly OwnerItem[]): string[] {
  return items.map((each) => each.id);
}

describe("consolidate: supersede and re-check (rules 1 and 2)", () => {
  it("withdraws batch-8's items on #761 and #764 once batch-9 asks at their new heads", () => {
    const batch8 = ["761", "764"].map((pr) => round(`batch-8/${pr}`, { keys: [`pr:acme/web#${pr}@${SHA_A}`], openedAt: at(1) }));
    const batch9 = ["761", "764"].map((pr) => round(`batch-9/${pr}`, { keys: [`pr:acme/web#${pr}@${SHA_B}`], openedAt: at(2) }));

    const flow = consolidate([...batch8, ...batch9]);

    expect(flow.withdrawn.map((each) => [each.item.id, each.reason])).toEqual([
      ["batch-8/761", `new-head:${SHA_B}`],
      ["batch-8/764", `new-head:${SHA_B}`],
    ]);
    expect(ids(flow.order)).toEqual(["batch-9/761", "batch-9/764"]);
  });

  it("takes the live head from heads over the newest item", () => {
    const fresh = round("fresh", { keys: [`pr:acme/web#1@${SHA_B}`] });

    const flow = consolidate([fresh], { heads: { "acme/web#1": SHA_A } });

    expect(flow.withdrawn.map((each) => each.reason)).toEqual([`new-head:${SHA_A}`]);
    expect(flow.order).toEqual([]);
  });

  it("drops, reasks or relates decisions-r3 Q1-Q3 against r2's Alert colours answers", () => {
    const colours = answered(round("r2/q1", { keys: ["ask:decisions/alert-colours", "token:alert-danger"] }), { optionId: "keep" }, 5);
    const contrast = answered(round("r2/q2", { keys: ["ask:decisions/alert-contrast"] }), { optionId: "keep" }, 1);
    const q1 = round("r3/q1", { keys: ["ask:decisions/alert-colours"], openedAt: at(3) });
    const q2 = round("r3/q2", { keys: ["ask:decisions/alert-contrast"], openedAt: at(3), options: OPTIONS, recommended: { optionId: "keep", by: "agent" } });
    const q3 = round("r3/q3", { keys: ["token:alert-danger"], openedAt: at(3) });

    const flow = consolidate([q1, q2, q3], { answered: [colours, contrast] });

    expect(flow.dropped.map((each) => [each.item.id, each.cite.answerId])).toEqual([["r3/q1", "r2/q1"]]);
    expect(flow.flags.map((each) => [each.itemId, each.kind])).toEqual([
      ["r3/q2", "reasked"],
      ["r3/q3", "related-answer"],
    ]);
    expect(ids(flow.order)).toEqual(["r3/q2", "r3/q3"]);
  });
});

describe("consolidate: dedupe, context and order", () => {
  it("merges same-kind items on one key but keeps a round apart from its gate", () => {
    const keys = [`pr:acme/web#9@${SHA_A}`];
    const first = item({ id: "ask-1", kind: "approve", keys });
    const second = item({ id: "ask-2", kind: "approve", keys, sources: [{ system: "hitl", ref: "g" }] });
    const review = round("round-1", { kind: "approve", keys });

    const flow = consolidate([second, review, first]);

    expect(ids(flow.order)).toEqual(["round-1", "ask-1"]);
    expect(flow.order[1]!.sources).toHaveLength(2);
    expect(flow.edges).toEqual([{ from: "round-1", to: "ask-1", rules: ["overlap"] }]);
  });

  it("orders VW-684's round before its gate and holds the gate on it", () => {
    const keys = ["task:VW-684", `pr:acme/web#684@${SHA_A}`];
    const review = round("vw-684-round", { kind: "decide", keys: [...keys, "ask:vw-684/q1"], openedAt: at(4) });
    const gate = item({ id: "vw-684-gate", kind: "approve", keys: [...keys, "gate:merge-684"], lens: "blocking-merge", door: "one-way" });

    const flow = consolidate([gate, review]);

    expect(ids(flow.order)).toEqual(["vw-684-round", "vw-684-gate"]);
    expect(flow.groups.map((group) => group.id)).toEqual(["pr:acme/web#684"]);
    expect(flow.held).toEqual([{ itemId: "vw-684-gate", waitsOn: ["vw-684-round"] }]);
  });

  it("shows a stacked PR's base as context and orders the base first", () => {
    const base = round("on-a", { keys: ["pr:acme/web#1"], openedAt: at(9) });
    const stacked = round("on-b", { keys: ["pr:acme/web#2"], door: "one-way" });

    const flow = consolidate([stacked, base], { stacks: { "acme/web#2": "acme/web#1" } });

    expect(flow.context).toEqual({ "on-b": ["acme/web#1"] });
    expect(flow.groups.map((group) => group.id)).toEqual(["pr:acme/web#1", "pr:acme/web#2"]);
    expect(flow.held).toEqual([{ itemId: "on-b", waitsOn: ["on-a"] }]);
  });

  it("puts a cross-PR decision in a topic group served before the PR groups", () => {
    const decision = item({ id: "spacing", keys: ["pr:acme/web#1", "pr:acme/web#2", "topic:spacing"], openedAt: at(9) });
    const reviews = ["1", "2"].map((pr) => round(`review-${pr}`, { keys: [`pr:acme/web#${pr}`] }));

    const flow = consolidate([...reviews, decision]);

    expect(flow.groups.map((group) => [group.id, group.kind])).toEqual([
      ["topic:spacing", "topic"],
      ["pr:acme/web#1", "pr"],
      ["pr:acme/web#2", "pr"],
    ]);
    expect(flow.held.map((each) => each.waitsOn)).toEqual([["spacing"], ["spacing"]]);
  });

  it("orders groups by how many items they likely change", () => {
    const upstream = item({ id: "z-upstream", keys: ["pr:acme/web#2", "task:A"], unblocks: ["task:B", "task:C"], openedAt: at(9) });
    const dependents = ["B", "C"].map((task) => round(`dep-${task}`, { keys: ["pr:acme/web#1", `task:${task}`] }));

    const flow = consolidate([...dependents, upstream]);

    expect(flow.groups.map((group) => group.id)).toEqual(["pr:acme/web#2", "pr:acme/web#1"]);
  });
});

describe("consolidate: shipBlockedBy", () => {
  const pr = `pr:acme/web#5@${SHA_A}`;
  const question = (id: string) => round(id, { keys: [pr, `ask:ship/${id}`], options: OPTIONS, recommended: { optionId: "keep", by: "agent" } });

  it("blocks Ship only on open change requests across the PR's tabs", () => {
    const answers = [
      answered(question("asked-changes"), { changeRequested: true }),
      answered(question("wrote-text"), { optionId: "keep", text: "Tighten the padding" }),
      answered(question("other-pick"), { optionId: "swap" }),
      answered(question("agreed"), { optionId: "keep" }),
      answered(item({ id: "gate-note", kind: "approve", keys: [pr] }), { text: "Rename the flag" }),
    ];
    const ship = item({ id: "ship", kind: "approve", keys: [pr] });

    const flow = consolidate([ship, question("unanswered")], { answered: answers });

    expect(flow.groups[0]!.shipBlockedBy).toEqual([
      { itemId: "asked-changes", reason: "change-requested", at: at(5) },
      { itemId: "gate-note", reason: "free-text", at: at(5) },
      { itemId: "other-pick", reason: "other-choice", at: at(5) },
      { itemId: "wrote-text", reason: "free-text", at: at(5) },
    ]);
  });

  it("ignores a change request on an old head or replaced by a newer answer", () => {
    const oldHead = answered(round("old", { keys: [`pr:acme/web#5@${SHA_B}`] }), { changeRequested: true }, 1);
    const replaced = answered(question("q"), { changeRequested: true }, 2);
    const settled = answered(question("q"), { optionId: "keep" }, 3);
    const ship = item({ id: "ship", kind: "approve", keys: [pr], openedAt: at(4) });

    const flow = consolidate([ship], { answered: [oldHead, replaced, { ...settled, id: "q-again" }] });

    expect(flow.groups[0]!.shipBlockedBy).toEqual([]);
  });

  it("gives topic groups no ship gate", () => {
    const flow = consolidate([item({ id: "loose", keys: ["topic:copy"] })]);

    expect(flow.groups).toEqual([{ id: "topic:copy", kind: "topic", itemIds: ["loose"] }]);
  });
});

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

describe("consolidate: input order", () => {
  it("returns the same Flow for every order of open and answered items", () => {
    const pr = `pr:acme/web#7@${SHA_B}`;
    const open = [
      round("old-head", { keys: [`pr:acme/web#7@${SHA_A}`], openedAt: at(1) }),
      round("review", { keys: [pr, "component:button"], openedAt: at(2) }),
      item({ id: "decide", keys: [pr, "component:button"], openedAt: at(2) }),
      item({ id: "gate-a", kind: "approve", keys: [pr, "task:T-1"], openedAt: at(2) }),
      item({ id: "gate-b", kind: "approve", keys: [pr, "task:T-1"], openedAt: at(2), sources: [{ system: "hitl", ref: "b" }] }),
      item({ id: "loose", keys: ["topic:copy"], openedAt: at(2) }),
    ];
    const answers = [
      answered(round("answer-1", { keys: [pr, "ask:x"] }), { changeRequested: true }, 3),
      answered(round("answer-2", { keys: [pr, "ask:x", "topic:copy"] }), { optionId: "keep" }, 3),
    ];
    const expected = consolidate(open, { answered: answers });

    for (const shuffled of permutations(open)) {
      expect(consolidate(shuffled, { answered: [...answers].reverse() })).toEqual(expected);
      expect(consolidate(shuffled, { answered: answers })).toEqual(expected);
    }
  });
});
