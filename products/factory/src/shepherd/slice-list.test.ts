import { describe, expect, it } from "vitest";
import { listedSlices, movedSlices } from "./slice-list.js";

describe("listedSlices", () => {
  it.each([
    ["S-numbered headings", "### S1: schema\n### S2 (packages/x)\n### S3 @vc: bind\n", ["S1", "S2", "S3"]],
    ["Slice-word headings", "### Slice a — forecast\n### Slice b\n", ["a", "b"]],
    ["bare letter headings", "### a: reader (1 pt)\n### b: wiring\n### f1\n", ["a", "b", "f1"]],
    ["a repeated heading once", "### S1: core\n## Tests\n### S1 (core.test.ts)\n", ["S1"]],
    ["no heading that only reads like one", "## Slices\n### a note on order\n### Summary\n## 4. Slices\n", []],
  ])("reads %s from a plan", (_, plan, expected) => {
    expect(listedSlices(plan, "")).toEqual(expected);
  });

  it("prefers the plan's headings over its notes", () => {
    expect(listedSlices("### S1: x\n", "Slices a, b, c")).toEqual(["S1"]);
  });

  it.each([
    ["a prose list", "plan: Slices S1 one (1, lite no), S2 two (0.5, lite yes). Open O1-O5.", ["S1", "S2"]],
    ["a number range", "Slices S1-S4 per the plan.", ["S1", "S2", "S3", "S4"]],
    ["a letter range", "slices a-c of the plan", ["a", "b", "c"]],
    ["an arrow order", "order j,g,i -> f1 -> e (e = TP-9 cut 1)", ["j", "g", "i", "f1", "e"]],
    ["a list ending in and", "slices a, b and c", ["a", "b", "c"]],
    ["two lists joined", "order a,b\nchain a,b,c = #1,#2,#3", ["a", "b", "c"]],
  ])("reads %s from the notes", (_, notes, expected) => {
    expect(listedSlices(undefined, notes)).toEqual(expected);
  });

  it.each([
    ["progress on some slices", "slices a, b done"],
    ["Shepherd's own hold line", "PR x merged; task left open: it has slices b, c"],
    ["a lone label", "the order a matters"],
    ["landing lines alone", "S1 landed in demo/x#1 at abc"],
  ])("lists nothing from %s, so a first landing cannot close the task", (_, notes) => {
    expect(listedSlices(undefined, notes)).toEqual([]);
  });
});

describe("movedSlices", () => {
  it.each([
    ["moved to", "Plan slice e moved to TP-9002 (margin)", ["e"]],
    ["left to", "Slice e left to TP-9002.", ["e"]],
    ["several, across an initiative", "Slices e, f were moved to demo/TP-9002", ["e", "f"]],
    ["an S label with no word slice", "S3 moved to CC-12", ["S3"]],
  ])("reads %s", (_, notes, expected) => {
    expect([...movedSlices(notes)]).toEqual(expected);
  });

  it.each(["e = TP-9002 cut 1", "slice e moved to the next sprint", "the task moved to TP-9002", "owns slices c-g from here"])("takes %j for no move", (notes) => {
    expect([...movedSlices(notes)]).toEqual([]);
  });
});
