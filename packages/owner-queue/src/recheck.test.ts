import { describe, expect, it } from "vitest";
import { askKey, componentKey, prKey, tokenKey, topicKey } from "./keys.js";
import { recheck } from "./recheck.js";
import type { OwnerAnswer, OwnerItem } from "./schema.js";
import { item, SHA_A, SHA_B } from "./test-fixtures.js";

const OPENED = "2026-01-02T00:00:00Z";
const BEFORE = "2026-01-01T00:00:00Z";
const AFTER = "2026-01-03T00:00:00Z";
const ASK = askKey("unit-a/q1");
const OPTIONS = [{ id: "red", label: "Red" }, { id: "blue", label: "Blue" }];

function open(id: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
  return item({ id, keys: [ASK], openedAt: OPENED, options: OPTIONS, recommended: { optionId: "red", by: "decider" }, ...overrides });
}

function answer(id: string, at: string, keys: string[], given: Partial<OwnerAnswer> = { optionId: "red" }): OwnerItem {
  return item({ id, keys, status: "answered", answer: { by: { class: "owner", id: "owner", channel: "round" }, at, ...given } });
}

describe("recheck", () => {
  it("drops an open item, citing the answer, once a newer answer shares its ask key", () => {
    const asked = open("round:r2/q1");
    const given = answer("round:r1/q1", AFTER, [ASK]);

    const result = recheck([asked], [given]);

    expect(result.open).toEqual([]);
    expect(result.dropped).toEqual([{ item: { ...asked, status: "gone-elsewhere" }, cite: { answerId: "round:r1/q1", key: ASK, at: AFTER } }]);
    expect(result.flags).toEqual([]);
  });

  it("cites the newest of several settling answers", () => {
    const given = [answer("a-early", "2026-01-03T00:00:00Z", [ASK]), answer("a-late", "2026-01-04T00:00:00Z", [ASK])];

    const result = recheck([open("b")], given);

    expect(result.dropped.map((drop) => drop.cite.answerId)).toEqual(["a-late"]);
  });

  it.each([
    ["component", componentKey("Alert")],
    ["token", tokenKey("color.alert")],
    ["topic", topicKey("Alert colours")],
  ])("never drops an item that shares only a %s key with a newer answer (rule 2)", (_kind, key) => {
    const asked = open("b", { keys: [askKey("other"), key] });
    const given = answer("a", AFTER, [askKey("elsewhere"), key], { optionId: "blue" });

    const result = recheck([asked], [given]);

    expect(result.open).toEqual([asked]);
    expect(result.dropped).toEqual([]);
    expect(result.flags).toEqual([{ itemId: "b", kind: "related-answer", answerId: "a", keys: [key] }]);
  });

  it("does not settle an item on a newer head with an answer given on an older head", () => {
    const asked = open("b", { keys: [ASK, prKey("org-a/repo-1", 12, SHA_B)] });
    const given = answer("a", AFTER, [ASK, prKey("org-a/repo-1", 12, SHA_A)], { optionId: "blue" });

    const result = recheck([asked], [given]);

    expect(result.open).toEqual([asked]);
    expect(result.flags).toEqual([{ itemId: "b", kind: "conflict", answerId: "a", keys: [ASK] }]);
  });

  it("settles an item when the answer was given on the same head", () => {
    const head = prKey("org-a/repo-1", 12, SHA_A);

    const result = recheck([open("b", { keys: [ASK, head] })], [answer("a", AFTER, [ASK, head])]);

    expect(result.dropped.map((drop) => drop.item.id)).toEqual(["b"]);
  });

  it("settles an item when neither side pins the PR to a head", () => {
    const pr = "pr:org-a/repo-1#12";

    const result = recheck([open("b", { keys: [ASK, pr] })], [answer("a", AFTER, [ASK, pr])]);

    expect(result.dropped.map((drop) => drop.item.id)).toEqual(["b"]);
  });

  it.each([
    ["the item is pinned and the answer is not", prKey("org-a/repo-1", 12, SHA_A), "pr:org-a/repo-1#12"],
    ["the answer is pinned and the item is not", "pr:org-a/repo-1#12", prKey("org-a/repo-1", 12, SHA_A)],
  ])("settles an item when %s, since an unpinned PR key pins no other head", (_case, itemPr, answerPr) => {
    const result = recheck([open("b", { keys: [ASK, itemPr] })], [answer("a", AFTER, [ASK, answerPr])]);

    expect(result.dropped.map((drop) => drop.item.id)).toEqual(["b"]);
  });

  it("flags an older answer that differs from the recommendation as a conflict", () => {
    const result = recheck([open("b")], [answer("a", BEFORE, [ASK], { optionId: "blue" })]);

    expect(result.open.map((each) => each.id)).toEqual(["b"]);
    expect(result.flags).toEqual([{ itemId: "b", kind: "conflict", answerId: "a", keys: [ASK] }]);
  });

  it("flags an older answer that picked the recommendation as reasked", () => {
    const result = recheck([open("b")], [answer("a", BEFORE, [ASK], { optionId: "red" })]);

    expect(result.flags).toEqual([{ itemId: "b", kind: "reasked", answerId: "a", keys: [ASK] }]);
  });

  it("treats an older change request on the recommended pick as a conflict", () => {
    const result = recheck([open("b")], [answer("a", BEFORE, [ASK], { optionId: "red", changeRequested: true })]);

    expect(result.flags.map((flag) => flag.kind)).toEqual(["conflict"]);
  });

  it("ignores answered items that carry no answer and answers sharing no relation key", () => {
    const unanswered = item({ id: "a", keys: [ASK], status: "answered" });
    const unrelated = answer("c", AFTER, [askKey("other"), "task:TP-1"]);

    const result = recheck([open("b", { keys: [ASK, "task:TP-1"] })], [unanswered, unrelated]);

    expect(result.open.map((each) => each.id)).toEqual(["b"]);
    expect(result.flags).toEqual([]);
  });

  it("gives the same output for any input order", () => {
    const items = [open("c"), open("b", { keys: [ASK, topicKey("alerts")] }), open("d", { keys: [askKey("x")] })];
    const given = [answer("a2", BEFORE, [ASK, topicKey("alerts")], { optionId: "blue" }), answer("a1", BEFORE, [ASK]), answer("a3", AFTER, [askKey("x")])];

    const forward = recheck(items, given);
    const backward = recheck([...items].reverse(), [...given].reverse());

    expect(backward).toEqual(forward);
    expect(forward.open.map((each) => each.id)).toEqual(["b", "c"]);
    expect(forward.dropped.map((drop) => drop.item.id)).toEqual(["d"]);
    expect(forward.flags.map((flag) => `${flag.itemId}<${flag.answerId}:${flag.kind}`)).toEqual([
      "b<a1:reasked",
      "b<a2:conflict",
      "c<a1:reasked",
      "c<a2:conflict",
    ]);
  });
});
