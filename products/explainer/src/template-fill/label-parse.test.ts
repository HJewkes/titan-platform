import { describe, expect, it } from "vitest";
import { spokenWordIndex } from "../script-schema.js";
import { firstWord, itemReveals } from "./label-parse.js";

// Synthetic parcel-desk line; none quotes a real script.
const beat = { id: "w2", spoken: "[Minutes](=time) later the label prints.", visual: { cues: [] } };

describe("a beat whose first word carries a reading declaration", () => {
  it("lands an element with no cue of its own on the word the listener hears", () => {
    // Catches: the default cue taken from the raw line, `[Minutes](=time)`, which no spoken word resolves to.
    const [reveal] = itemReveals(beat, "rows", 1);

    expect(firstWord(beat)).toBe("Minutes");
    expect(spokenWordIndex(beat)(reveal!.atCue)).toBe(0);
  });
});
