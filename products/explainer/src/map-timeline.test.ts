import { describe, expect, it } from "vitest";
import { cueResolverFromWords } from "./cues.js";
import { mapBeat, offMap, reveal } from "./map-fixtures.test-helpers.js";
import { MapBeatSchema } from "./map-state.js";
import { compileMapTimeline } from "./map-timeline.js";

const words = cueResolverFromWords({
  "beat-01": [
    { word: "Requests", startS: 0.2 },
    { word: "enter", startS: 0.9 },
    { word: "here,", startS: 1.4 },
    { word: "here", startS: 3 },
  ],
  "beat-03": [
    { word: "here", startS: 2 },
    { word: "store", startS: 4 },
  ],
});

const firstMapBeat = mapBeat("beat-01", {
  level: "containers",
  camera: { fit: ["web", "api"], atCue: "enter" },
  reveal: [
    { id: "api", atCue: "here#2" },
    { id: "web", atCue: "here" },
  ],
  focus: { ids: ["api"], atCue: "here#2" },
});

describe("compileMapTimeline", () => {
  it("compiles a map, non-map, map sequence into two segments at absolute times", () => {
    const beats = [firstMapBeat, offMap("beat-02"), mapBeat("beat-03", { level: "components", reveal: reveal("store") })];
    const { segments } = compileMapTimeline(beats, words);

    expect(segments.map((s) => [s.beatId, s.startS, s.endS, s.resumed])).toEqual([
      ["beat-01", 0, 10, false],
      ["beat-03", 20, 30, true],
    ]);
    expect(segments[0]?.events).toEqual([
      { atS: 0.9, kind: "camera", id: "api,web" },
      { atS: 1.4, kind: "reveal", id: "web" },
      { atS: 3, kind: "focus", id: "api" },
      { atS: 3, kind: "reveal", id: "api" },
    ]);
    expect(segments[1]?.events).toEqual([{ atS: 22, kind: "reveal", id: "store" }]);
  });

  it("starts a map beat that re-enters the map from the last map beat's end state", () => {
    const beats = [firstMapBeat, offMap("beat-02"), mapBeat("beat-03", { level: "containers" })];
    const [first, second] = compileMapTimeline(beats, words).segments;

    expect(first?.end).toEqual({ level: "containers", camera: { fit: ["api", "web"] }, revealed: ["api", "web"], focus: ["api"], active: [] });
    expect(second?.start).toEqual(first?.end);
    expect(second?.end).toEqual(first?.end);
  });

  it("lets a re-entering beat override the camera and focus it resumes", () => {
    const beats = [
      firstMapBeat,
      offMap("beat-02"),
      mapBeat("beat-03", { level: "containers", camera: { station: "overview", atCue: "store" }, focus: { ids: [], atCue: "store" } }),
    ];
    const second = compileMapTimeline(beats, words).segments[1];

    expect(second?.end).toMatchObject({ camera: { station: "overview" }, revealed: ["api", "web"], focus: [] });
  });

  it("gives the same output whatever order a beat's fields and lists are written in", () => {
    const shuffled = MapBeatSchema.parse(reverseAll(firstMapBeat));

    expect(JSON.stringify(compileMapTimeline([shuffled], words))).toBe(JSON.stringify(compileMapTimeline([firstMapBeat], words)));
  });

  it("throws on a cue the beat never speaks", () => {
    const beats = [mapBeat("beat-01", { level: "context", reveal: [{ id: "web", atCue: "nowhere" }] })];

    expect(() => compileMapTimeline(beats, words)).toThrow(/nowhere/);
  });
});

function reverseAll(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseAll).reverse();
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseAll(v)]));
}
