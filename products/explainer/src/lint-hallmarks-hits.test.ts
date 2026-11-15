import { describe, expect, it } from "vitest";
import { beatsOf, NAMING, withFiller } from "./hallmark-fixtures.test-helpers.js";
import { hallmarkHits } from "./lint-hallmarks.js";

describe("hallmarkHits", () => {
  it("lists each naming sentence with its beat and row", () => {
    const hits = hallmarkHits(withFiller(...NAMING));

    expect(hits).toEqual(NAMING.map((text, i) => ({ beat: `b${11 + i}`, text, row: "hallmark:naming-refrain" })));
  });

  it("lists a teaser, a label-first line and a colon tricolon under their own rows", () => {
    const lines = ["By the end of this, you'll be able to fix any kettle.", "The fix is to descale it.", "Leave it on and you get a kettle: loud, slow and hot."];

    expect(hallmarkHits(beatsOf(lines)).map((hit) => [hit.text, hit.row])).toEqual([
      [lines[0], "hallmark:teaser"],
      [lines[1], "hallmark:label-first"],
      [lines[2], "hallmark:colon-tricolon"],
    ]);
  });

  it("lists nothing for plain garden lines", () => {
    expect(hallmarkHits(beatsOf(["Rain in the garden change slowly over a season, and a patient grower learns to read them well."]))).toEqual([]);
  });

  it("skips rows that never flag a sentence, such as staccato runs", () => {
    const lines = ["Rain falls.", "Soil drinks.", "Roots grow.", "Weeds wait."];

    expect(hallmarkHits(beatsOf(lines))).toEqual([]);
  });
});
