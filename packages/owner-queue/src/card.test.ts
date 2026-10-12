import { describe, expect, it } from "vitest";
import { cardLint, ownerCardSchema } from "./card.js";
import { ownerItemSchema, type OwnerItem } from "./schema.js";
import { item } from "./test-fixtures.js";

function card(overrides: Partial<OwnerItem> = {}): OwnerItem {
  return item({
    id: "gate:g-1",
    kind: "approve",
    door: "one-way",
    class: "D1",
    irreversible: "The merge lands on main and deploys.",
    shown: ["https://github.com/o/r/pull/1", "/tmp/review.md", "$ gh pr checks 1"],
    default: "hold",
    onSilence: { action: "wait" },
    options: [
      { id: "merge", label: "Merge", consequence: "Lands on main now." },
      { id: "hold", label: "Hold", consequence: "The PR waits; nothing ships." },
    ],
    ...overrides,
  });
}

function issuesOf(candidate: unknown): string[] {
  const parsed = ownerCardSchema.safeParse(candidate);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("cardLint and ownerCardSchema", () => {
  it("accept a one-way approve card carrying every field", () => {
    expect(cardLint(card())).toEqual([]);
    expect(ownerCardSchema.safeParse(card()).success).toBe(true);
  });

  it("flag a decision with one option", () => {
    const one = card({ default: undefined, options: [{ id: "merge", label: "Merge", consequence: "Lands." }] });

    expect(cardLint(one)).toContain("card:options");
    expect(ownerCardSchema.safeParse(one).success).toBe(false);
  });

  it("flag a decision with no options", () => {
    expect(cardLint(card({ default: undefined, options: undefined }))).toContain("card:options");
  });

  it("refuse an option without a consequence", () => {
    const bare = card({ options: [{ id: "merge", label: "Merge", consequence: "Lands." }, { id: "hold", label: "Hold" }] });

    expect(issuesOf(bare)).toEqual(["card:consequence"]);
  });

  it("refuse a one-way item that does not say what it cannot undo", () => {
    expect(issuesOf(card({ irreversible: undefined }))).toEqual(["card:one-way-irreversible"]);
  });

  it("refuse a one-way item that does not wait on silence", () => {
    expect(issuesOf(card({ onSilence: { action: "apply-default", afterHours: 24 } }))).toEqual(["card:one-way-waits"]);
    expect(issuesOf(card({ onSilence: { action: "expire", afterHours: 24 } }))).toEqual(["card:one-way-waits"]);
  });

  it("let a two-way item apply its default on silence", () => {
    const twoWay = card({ door: "two-way", irreversible: undefined, onSilence: { action: "apply-default", afterHours: 48 } });

    expect(issuesOf(twoWay)).toEqual([]);
  });

  it("refuse a decision with no class or no on-silence", () => {
    expect(issuesOf(card({ class: undefined, onSilence: undefined }))).toEqual(["card:class", "card:on-silence"]);
  });

  it("flag a default that is not one of the option ids", () => {
    expect(cardLint(card({ default: "ship" }))).toEqual(["card:default-not-option"]);
  });

  it("flag apply-default with no default", () => {
    const noDefault = card({ door: "two-way", default: undefined, onSilence: { action: "apply-default", afterHours: 1 } });

    expect(cardLint(noDefault)).toEqual(["card:apply-default-needs-default"]);
  });

  it("lint a know item with no options clean", () => {
    expect(cardLint(item({ id: "k-1", kind: "know", door: "one-way", lens: "fyi" }))).toEqual([]);
  });

  it("lint only the fields a non-decision item sets", () => {
    const review = item({ id: "r-1", kind: "review", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });

    expect(cardLint(review)).toEqual(["card:consequence"]);
  });
});

describe("ownerItemSchema with card fields", () => {
  it("still parses an item that carries none of them", () => {
    const plain = item({ id: "chat:m-1" });

    expect(ownerItemSchema.parse(plain)).toEqual(plain);
  });

  it("parses a full card", () => {
    expect(ownerItemSchema.parse(card())).toEqual(card());
  });

  it.each([
    ["a class outside D<n>", { class: "X1" }],
    ["a multi-line irreversible", { irreversible: "one\ntwo" }],
    ["a shown ref that is a relative path", { shown: ["review.md"] }],
    ["an http shown ref", { shown: ["http://example.com"] }],
    ["an empty shown list", { shown: [] }],
    ["apply-default without hours", { onSilence: { action: "apply-default" } }],
    ["a wait with hours", { onSilence: { action: "wait", afterHours: 3 } }],
    ["hours past 30 days", { onSilence: { action: "expire", afterHours: 721 } }],
  ])("refuses %s", (_label, extra) => {
    expect(ownerItemSchema.safeParse({ ...card(), ...extra }).success).toBe(false);
  });

  it("refuses a multi-line option consequence", () => {
    const options = [{ id: "a", label: "A", consequence: "x\ny" }, { id: "b", label: "B", consequence: "y" }];

    expect(ownerItemSchema.safeParse({ ...card(), options }).success).toBe(false);
  });
});
