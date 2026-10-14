import type { PillScene } from "@titan-design/graph-layout";
import { describe, expect, it } from "vitest";
import { CAPTION_KEEP_OUT } from "./camera.js";
import { cueResolverFromWords } from "./cues.js";
import { mapBeat, offMap } from "./map-fixtures.test-helpers.js";
import { placeTimelinePins, type PinLayout } from "./map-pins.js";
import { compileMapTimeline } from "./map-timeline.js";

const words = cueResolverFromWords({
  "beat-01": [
    { word: "first", startS: 1 },
    { word: "then", startS: 2 },
  ],
  "beat-03": [{ word: "low", startS: 0.5 }],
});

const FRAME = { x: 0, y: 0, width: 1200, height: 675 };
const apiScene: PillScene = { frame: FRAME, anchors: [{ id: "api", rect: { x: 520, y: 160, width: 160, height: 60 } }], obstacles: [] };
const lowScene: PillScene = { frame: FRAME, anchors: [{ id: "store", rect: { x: 520, y: 470, width: 160, height: 60 } }], obstacles: [] };
const layout = (scenes: Record<string, PillScene>): PinLayout => ({
  sceneFor: (beatId) => scenes[beatId],
  metrics: { fontSize: 20, charWidth: 0.6, padding: 6, bodyHeight: 0 },
  gap: 8,
});

// Alphabetical order of the texts is the reverse of cue order.
const twoPins = mapBeat("beat-01", {
  level: "containers",
  pins: [
    { anchor: "api", text: "zeta retries", atCue: "first" },
    { anchor: "api", text: "alpha cache", atCue: "then" },
  ],
});
const lowPin = mapBeat("beat-03", { level: "containers", pins: [{ anchor: "store", text: "hot path", atCue: "low" }] });
const beats = [twoPins, offMap("beat-02"), lowPin];

describe("placeTimelinePins", () => {
  // catches: ranking pins by text or authored order instead of cue time
  it("writes each pin's box into its segment, the earlier cue nearest its box", () => {
    const timeline = compileMapTimeline(beats, words);

    const [first] = placeTimelinePins(timeline, beats, words, layout({ "beat-01": apiScene })).segments;

    expect(first?.events).toEqual(timeline.segments[0]?.events);
    expect(first?.pins.map((p) => [p.atS, p.text, p.box?.y])).toEqual([
      [1, "zeta retries", 228],
      [2, "alpha cache", 268],
    ]);
  });

  // catches: placing against the full frame instead of the caption keep-out
  it("keeps a pin on a low box above the caption keep-out", () => {
    const pinned = placeTimelinePins(compileMapTimeline(beats, words), beats, words, layout({ "beat-03": lowScene }));

    const box = pinned.segments[1]?.pins[0]?.box;
    expect(box).not.toBeNull();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(FRAME.height * CAPTION_KEEP_OUT);
    expect(pinned.segments[1]?.pins[0]?.atS).toBe(20.5);
  });

  // catches: inventing a box for a beat with no scene, which the painter would draw over the map
  it("leaves a pin's box null when its beat has no scene", () => {
    const pinned = placeTimelinePins(compileMapTimeline(beats, words), beats, words, layout({}));

    expect(pinned.segments.flatMap((s) => s.pins.map((p) => p.box))).toEqual([null, null, null]);
  });
});
