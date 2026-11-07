import { describe, expect, it } from "vitest";
import { carriesUnlanded } from "./task-close.js";

const progress = (planned: number, ...unlanded: string[]) => ({ planned, unlanded });

describe("carriesUnlanded", () => {
  it("carries every unlanded slice a Carries slices line names, as #3257 did for a and b", () => {
    expect(carriesUnlanded(progress(2, "a", "b"), "What\n\nCarries slices: a and b\n", [])).toBe(true);
  });

  it("carries the plan's only slice with no declaration and no sibling open, as #3250 did", () => {
    expect(carriesUnlanded(progress(1, "a"), "Bridge task.", [])).toBe(true);
  });

  it.each([
    ["a mention of slices", "Slices b and c follow in later PRs."],
    ["a mention beside a slice already landed", "Slice b of the plan. Slice c follows in a later PR."],
    ["no body", undefined],
  ])("does not carry later slices of a longer plan on %s", (_, body) => {
    expect(carriesUnlanded(progress(3, "b", "c"), body, [])).toBe(false);
    expect(carriesUnlanded(progress(3, "c"), body, [])).toBe(false);
  });

  it("does not carry when the Carries slices line names only some of the unlanded slices", () => {
    expect(carriesUnlanded(progress(3, "a", "b", "c"), "Carries slices: a, b", [])).toBe(false);
  });

  it("does not carry a declared slice while another registered PR is open", () => {
    expect(carriesUnlanded(progress(2, "a", "b"), "Carries slices: a, b", ["octo/demo#9"])).toBe(false);
    expect(carriesUnlanded(progress(1, "a"), "", ["octo/demo#9"])).toBe(false);
  });

  it("does not carry on a Last slice: no line, and Last slice: yes carries past an open sibling", () => {
    expect(carriesUnlanded(progress(1, "a"), "Last slice: no", [])).toBe(false);
    expect(carriesUnlanded(progress(3, "a", "b"), "Last slice: yes", ["octo/demo#2"])).toBe(true);
  });
});
