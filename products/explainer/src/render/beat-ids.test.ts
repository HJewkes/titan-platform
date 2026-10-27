import { describe, expect, it } from "vitest";
import { beatIdMap, renameWordsBeats, storyboardIds } from "./beat-ids.js";

describe("storyboard beat ids", () => {
  it("numbers the beats resolve kept in script order, skipping a cut beat", () => {
    const script = { beats: [{ id: "intro" }, { id: "cut-me" }, { id: "close" }] };

    const ids = storyboardIds(script, { cut: [{ id: "cut-me", chapter: "c", code: "sim", detail: "cut" }] });

    expect([...ids]).toEqual([["intro", "beat-01"], ["close", "beat-02"]]);
  });

  it("widens the number past 99 beats, so every id stays unique", () => {
    const ids = beatIdMap(Array.from({ length: 100 }, (_, i) => `s${i}`));

    expect([ids.get("s0"), ids.get("s99")]).toEqual(["beat-001", "beat-100"]);
  });

  it("renames words.json beats through the map and keeps their other fields", () => {
    const words = { schema: "explainer.words/v1", beats: [{ id: "intro", startS: 0, words: [] }, { id: "stray", startS: 1, words: [] }] };

    const renamed = renameWordsBeats(words, new Map([["intro", "beat-01"]]));

    expect(renamed).toEqual({ schema: "explainer.words/v1", beats: [{ id: "beat-01", startS: 0, words: [] }, { id: "stray", startS: 1, words: [] }] });
  });
});
