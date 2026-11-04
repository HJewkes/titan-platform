import { describe, expect, it } from "vitest";
import { ScriptSchema, type ScriptV1 } from "../script-schema.js";
import { fill, fixtureScript, rawFixture } from "../template-fill/fill-fixtures.test-helpers.js";
import { beatIdMap } from "./beat-ids.js";
import { boardFromFill } from "./board-from-fill.js";

/** The fixture with a chip on its second beat, so the extras carry one. */
function chippedScript(): ScriptV1 {
  const raw = rawFixture();
  const beats = raw.beats.map((beat) => (beat.id === "b2" ? { ...beat, visual: { ...beat.visual, chips: [{ kind: "illustrative", text: "Invented desk" }] } } : beat));
  return ScriptSchema.parse({ ...raw, beats });
}

describe("boardFromFill page extras", () => {
  it("keys each beat's extras by its storyboard id, in fill order, carrying what the fill drew", () => {
    // Arrange
    const script = chippedScript();
    const filled = fill(script);
    const ids = beatIdMap(filled.beats.map((beat) => beat.id));

    // Act
    const { board, extras } = boardFromFill(script, filled, ids);

    // Assert
    const expectedIds = filled.beats.map((beat) => ids.get(beat.id));
    expect([...extras.keys()]).toEqual(expectedIds);
    expect(board.beats.map((beat) => beat.id)).toEqual(expectedIds);
    expect(extras.get(ids.get("b2")!)?.chips).toEqual([{ kind: "illustrative", text: "Invented desk" }]);
    expect(filled.beats.some((beat) => beat.reveals.length > 0)).toBe(true);
    for (const drawn of filled.beats) {
      const { reveals, chips, hints } = drawn;
      const continues = hints.continues === undefined ? {} : { continues: ids.get(hints.continues) };
      expect(extras.get(ids.get(drawn.id)!)).toMatchObject({ reveals, chips, hints: { ...hints, ...continues } });
    }
  });

  it("takes the headline from the beat's assertion and numbers its chapter out of the script's", () => {
    // Arrange
    const script = fixtureScript();
    const filled = fill(script);
    const ids = beatIdMap(filled.beats.map((beat) => beat.id));
    const beat = script.beats.find((each) => each.chapter === script.chapters[1]!.id)!;

    // Act
    const { extras } = boardFromFill(script, filled, ids);

    // Assert
    expect(extras.get(ids.get(beat.id)!)).toMatchObject({
      headline: beat.visual.assertion,
      chapter: { n: 2, of: script.chapters.length, label: script.chapters[1]!.label },
    });
  });

  it("names the beat a continuation follows by its storyboard id, not its script id", () => {
    // Arrange
    const script = fixtureScript();
    const filled = fill(script);
    const ids = beatIdMap(filled.beats.map((beat) => beat.id));

    // Act
    const { extras } = boardFromFill(script, filled, ids);

    // Assert
    expect(filled.beats.find((beat) => beat.id === "b3")?.hints.continues).toBe("b2");
    expect(extras.get(ids.get("b3")!)?.hints.continues).toBe(ids.get("b2"));
  });
});
