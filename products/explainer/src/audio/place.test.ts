import { describe, expect, it } from "vitest";
import { cueResolverFromWords } from "../cues.js";
import { placeSfx } from "./place.js";

const resolve = cueResolverFromWords({
  b1: [
    { word: "step", startS: 1 },
    { word: "one", startS: 1.5 },
    { word: "step", startS: 3 },
  ],
});
const starts = { b1: 20 };

describe("placeSfx", () => {
  it("lands an sfx at beat start plus the cue word start minus the anchor", () => {
    const { hits, warnings } = placeSfx([{ sfxId: "whoosh", beatId: "b1", cue: "step#2", anchorS: 0.5 }], starts, resolve);
    expect(hits).toEqual([{ sfxId: "whoosh", atS: 22.5 }]);
    expect(warnings).toEqual([]);
  });

  it("keeps the first of two hits closer than 0.25 s and warns", () => {
    const { hits, warnings } = placeSfx(
      [
        { sfxId: "a", beatId: "b1", cue: "step#1", anchorS: 0 },
        { sfxId: "b", beatId: "b1", cue: "step#1", anchorS: -0.2 },
      ],
      starts,
      resolve,
    );
    expect(hits.map((h) => h.sfxId)).toEqual(["a"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("b");
  });

  it("keeps two hits exactly 0.25 s apart", () => {
    const { hits } = placeSfx(
      [
        { sfxId: "a", beatId: "b1", cue: "step#1", anchorS: 0 },
        { sfxId: "b", beatId: "b1", cue: "step#1", anchorS: -0.25 },
      ],
      starts,
      resolve,
    );
    expect(hits).toHaveLength(2);
  });

  it("orders hits by time regardless of request order", () => {
    const { hits } = placeSfx(
      [
        { sfxId: "late", beatId: "b1", cue: "step#2", anchorS: 0 },
        { sfxId: "early", beatId: "b1", cue: "step#1", anchorS: 0 },
      ],
      starts,
      resolve,
    );
    expect(hits.map((h) => h.sfxId)).toEqual(["early", "late"]);
  });

  it("throws on a beat with no start", () => {
    expect(() => placeSfx([{ sfxId: "a", beatId: "nope", cue: "step", anchorS: 0 }], starts, resolve)).toThrow(/nope/);
  });
});
