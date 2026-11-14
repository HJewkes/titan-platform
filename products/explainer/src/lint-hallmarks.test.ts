import { describe, expect, it } from "vitest";
import { beatsOf, FILLER, NAMING, rowOf, tourOf, withFiller } from "./hallmark-fixtures.test-helpers.js";
import { hallmarkCheck, textHallmarkRows } from "./lint-hallmarks.js";
import { lint, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

describe("hallmark rows on filler alone", () => {
  it("passes every text hallmark on 160 words of varied garden lines", () => {
    const rows = textHallmarkRows(beatsOf(FILLER));

    expect(rows.filter((row) => !row.pass).map((row) => row.id)).toEqual([]);
  });
});

describe("hallmark:naming-refrain", () => {
  it("errors on three short naming lines across three beats and names the beats", () => {
    const row = rowOf(withFiller(...NAMING), "hallmark:naming-refrain");

    expect(row).toMatchObject({ value: 3, severity: "error", pass: false, beats: ["b11", "b12", "b13"] });
  });

  it("warns on two short naming lines", () => {
    const row = rowOf(withFiller(...NAMING.slice(0, 2)), "hallmark:naming-refrain");

    expect(row).toMatchObject({ value: 2, severity: "warning", pass: false });
  });

  it("does not count a naming clause inside a working sentence", () => {
    const working = "We call this the gear ratio because it decides how far one pedal turn takes you.";

    const row = rowOf(withFiller(working, working, working), "hallmark:naming-refrain");

    expect(row).toMatchObject({ value: 0, pass: true });
  });

});

describe("hallmark:named-before-defined", () => {
  const specs = (speaker: string, declarer: string): BeatSpec[] =>
    Array.from({ length: 10 }, (_, i): BeatSpec => {
      const id = `r${i + 1}`;
      const spoken = id === speaker ? "The pedal turns and torque reaches the wheel." : "The chain moves when the rider pushes down.";
      return [id, "ch1", "WHAT", spoken, id === declarer ? { new_terms: ["torque"] } : {}];
    });
  const rowFor = (speaker: string, declarer: string) => lint(tourOf(specs(speaker, declarer)), [hallmarkCheck]).get("hallmark:named-before-defined")!;

  it("errors when r9 speaks a term that r10 declares, naming the speaking beat", () => {
    expect(rowFor("r9", "r10")).toMatchObject({ severity: "error", pass: false, value: 1, detail_beats: ["r9"] });
  });

  it("passes when the declaring beat comes first", () => {
    expect(rowFor("r10", "r9")).toMatchObject({ pass: true, value: 0 });
  });
});

describe("hallmark:colon-tricolon", () => {
  it("fires on a colon and a list of three that ends the sentence", () => {
    expect(rowOf(withFiller("Leave it on and you get a kettle: loud, slow and hot."), "hallmark:colon-tricolon")).toMatchObject({ value: 1, pass: false });
  });

  it("does not fire on a ratio written with a colon", () => {
    expect(rowOf(withFiller("The ratio is 3: 2.", "Gear ratios run 3: 2, 4 and 5."), "hallmark:colon-tricolon")).toMatchObject({ value: 0, pass: true });
  });
});

describe("hallmark:teaser", () => {
  it.each([
    "By the end of this, you'll be able to fix any kettle.",
    "Three changes fix that.",
  ])("fires on %s", (line) => {
    expect(rowOf(withFiller(line), "hallmark:teaser")).toMatchObject({ value: 1, pass: false });
  });
});

describe("hallmark rows under 150 words", () => {
  it("report only, even with three naming lines", () => {
    const row = rowOf(beatsOf(NAMING), "hallmark:naming-refrain");

    expect(row).toMatchObject({ severity: "report-only", pass: true });
  });
});
