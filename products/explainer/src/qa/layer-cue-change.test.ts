import { FRAMEDIFF_HEIGHT, FRAMEDIFF_WIDTH } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { cueFrameTimes, cueWindows, stillCueRows } from "./layer-cue-change.js";

// Synthetic: an invented parcel desk.
const cue = (target: string, atCue: string, untilCue?: string) => ({ action: "V6" as const, target, atCue, ...(untilCue ? { untilCue } : {}) });

/** A 320x180 grey frame at rest, with `changed` pixels moved well past qa's pixel tolerance. */
const frame = (changed = 0): Uint8Array => {
  const grey = new Uint8Array(FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT).fill(40);
  grey.fill(200, 0, changed);
  return grey;
};

describe("the frames a cue word is read over", () => {
  it("reads the frame before the word, then five a second for a second, stopping short of the next cue word", () => {
    // Arrange
    const at = { parcels: 1, full: 1.7 };

    // Act
    const windows = cueWindows([cue("desk", "parcels"), cue("desk", "full")], at, 4);

    // Assert
    expect(windows.map(({ cue: word, beforeS, afterS }) => ({ word, beforeS, afterS: afterS.map((t) => Number(t.toFixed(3))) }))).toEqual([
      { word: "parcels", beforeS: 1 - 1 / 30, afterS: [1.2, 1.4, 1.6] },
      { word: "full", beforeS: 1.7 - 1 / 30, afterS: [1.9, 2.1, 2.3, 2.5, 2.7] },
    ]);
  });

  it("names every target a cue word times, its until-cue included, and reads each second once in order", () => {
    // Arrange
    const cues = [cue("desk", "parcels"), cue("bin", "parcels"), cue("van", "load", "parcels")];

    // Act
    const windows = cueWindows(cues, { load: 0.5, parcels: 3 }, 4);

    // Assert
    expect(windows.find((w) => w.cue === "parcels")?.targets).toEqual(["desk", "bin", "van"]);
    const times = cueFrameTimes(windows);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });

  it("reads a cue word just before the next one when that word follows within a sample step", () => {
    // Act
    const windows = cueWindows([cue("desk", "parcels"), cue("bin", "wait")], { parcels: 1, wait: 1.1 }, 4);

    // Assert
    expect(windows[0]?.afterS).toEqual([1.1 - 1 / 30]);
  });
});

describe("a cue word that does not change the picture", () => {
  const windows = cueWindows([cue("desk", "full")], { full: 1 }, 4);

  it("is a still-cue row on its targets when no frame after it moves more than qa's static level", () => {
    // Arrange
    const grey = (t: number) => frame(t < 1 ? 0 : 10);

    // Act
    const rows = stillCueRows("b-desk", windows, grey);

    // Assert
    expect(rows).toEqual([{ beat: "b-desk", element: "desk", rule: "still-cue", text: "full", atS: 1 }]);
  });

  it("is no row when a pulse lights the element after its word and has returned to rest within the second", () => {
    // Arrange
    const grey = (t: number) => frame(t > 1.3 && t < 1.5 ? 4_000 : 0);

    // Act
    const rows = stillCueRows("b-desk", windows, grey);

    // Assert
    expect(rows).toEqual([]);
  });
});
