import { describe, expect, it } from "vitest";
import { listedSlices, movedSlices } from "./slice-list.js";

describe("listedSlices", () => {
  it.each([
    ["S-numbered headings", "### S1: schema\n### S2 (packages/x)\n### S3 @vc: bind\n", ["S1", "S2", "S3"]],
    ["Slice-word headings", "### Slice a — forecast\n### Slice b\n", ["a", "b"]],
    ["bare letter headings", "### a: reader (1 pt)\n### b: wiring\n### f1\n", ["a", "b", "f1"]],
    ["a repeated heading once", "### S1: core\n### S2: wire\n## Tests\n### S1 (core.test.ts)\n", ["S1", "S2"]],
    ["no list from one slice section", "## Slice c redesign (2026-10-25)\n", []],
    ["no heading that only reads like one", "## Slices\n### a note on order\n### Summary\n## 4. Slices\n", []],
  ])("reads %s from a plan", (_, plan, expected) => {
    expect(listedSlices(plan, "")).toEqual(expected);
  });

  it("prefers the plan's headings over its notes", () => {
    expect(listedSlices("### S1: x\n### S2: y\n", "order a -> b")).toEqual(["S1", "S2"]);
  });

  it("extends a heading list by a re-plan in the notes that shares its labels", () => {
    expect(listedSlices("### S1: x\n### S2: y\n", "re-plan: order S1 -> S2 -> S3")).toEqual(["S1", "S2", "S3"]);
  });

  it.each([
    ["a prose list", "plan: Slices S1 one (1, lite no), S2 two (0.5, lite yes). Open O1-O5.", ["S1", "S2"]],
    ["an arrow order", "order j,g,i -> f1 -> e (e = TP-9 cut 1)", ["j", "g", "i", "f1", "e"]],
    ["both declarations once", "order S1 -> S2\nSlices S1 one, S2 two.", ["S1", "S2"]],
  ])("reads %s from the notes", (_, notes, expected) => {
    expect(listedSlices(undefined, notes)).toEqual(expected);
  });

  it.each([
    ["progress on some slices", "slices a, b done"],
    ["a comma list", "Slices a and c are parallel; slices b,c next"],
    ["a partial range", "operator owns slices e-h"],
    ["a range across a plan", "Slices a-c of the plan merged"],
    ["a chain without an order", "chain a,b,c = #1,#2,#3"],
    ["an order with no arrow", "order a, b"],
    ["a lone described slice", "Slices S5 only, for now."],
    ["undescribed labels with a status", "Slices S1, S2 done."],
    ["two labels joined in one remark", "Slices S1 and S3 can run in parallel."],
    ["a range with a status", "slices S2-S3 left to review"],
    ["items that report status", "Slices S1 done, S2 pending."],
    ["one undescribed item among described ones", "Slices S1 schema, S2, S3 replay."],
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
    ["an S label mid-sentence", "so S3 moved to CC-12", ["S3"]],
    ["a bare number after the word slice", "Slice 2 moved to TP-9", ["2"]],
    ["a bare number opening a clause", "Re-cut. 2 moved to TP-9", ["2"]],
  ])("reads %s", (_, notes, expected) => {
    expect([...movedSlices(notes)]).toEqual(expected);
  });

  it.each(["e = TP-9002 cut 1", "slice e moved to the next sprint", "the task moved to TP-9002", "owns slices c-g from here", "Phase 2 moved to TP-9"])("takes %j for no move", (notes) => {
    expect([...movedSlices(notes)]).toEqual([]);
  });
});
