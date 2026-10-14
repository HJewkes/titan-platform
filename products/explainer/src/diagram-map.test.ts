import { describe, expect, it } from "vitest";
import { cueResolverFromWords } from "./cues.js";
import { tdMapTimelineFixture } from "./diagram-map-fixture.test-helpers.js";
import { DiagramMapTimelineSchema, toDiagramMapTimeline, type DiagramMapKeyframe } from "./diagram-map.js";
import { mapBeat } from "./map-fixtures.test-helpers.js";
import { MapBeatSchema, type MapBeat } from "./map-state.js";
import { compileMapTimeline } from "./map-timeline.js";

const SHA = "sha256:synthetic-fixture";

const beat = (id: string, duration_s: number, map_state?: Record<string, unknown>): MapBeat =>
  MapBeatSchema.parse({ id, duration_s, visual: { job: map_state ? "map" : "numbers", layout_source: "code-graph", ...(map_state ? { map_state } : {}) } });

// The fixture's story as a storyboard: a 6 s map beat, 3 s off the map, then a 5 s map beat at code level.
const fixtureStory = [
  beat("beat-01", 6, {
    level: "containers",
    reveal: [
      { id: "pkg/web", atCue: "web" },
      { id: "pkg/api", atCue: "api" },
      { id: "pkg/store", atCue: "store" },
    ],
    edges: [
      { id: "e:web->api", atCue: "api" },
      { id: "e:api->store", atCue: "store" },
    ],
    focus: { ids: ["pkg/web", "pkg/api"], atCue: "both" },
  }),
  beat("beat-02", 3),
  beat("beat-03", 5, {
    level: "code",
    reveal: [{ id: "pkg/api/routes/notes.ts", atCue: "notes" }],
    focus: { ids: ["pkg/api/routes/notes.ts"], atCue: "this" },
    cards: [{ ref: "card:notes.ts", atCue: "card", untilCue: "gone" }],
  }),
];

const fixtureWords = cueResolverFromWords({
  "beat-01": [
    { word: "web", startS: 0.5 },
    { word: "api", startS: 1.5 },
    { word: "store", startS: 2.5 },
    { word: "both", startS: 4 },
  ],
  "beat-03": [
    { word: "notes", startS: 0.2 },
    { word: "this", startS: 0.5 },
    { word: "card", startS: 1 },
    { word: "gone", startS: 3.5 },
  ],
});

const convert = (beats: MapBeat[], words = fixtureWords, cameraBox = () => ({ x: 0, y: 0, width: 160, height: 90 })) =>
  toDiagramMapTimeline(compileMapTimeline(beats, words), { layoutSha: SHA, cameraBox });

const CUED_OPS = new Set(["reveal", "edge", "focus", "card-in", "card-out"]);
// titan-design only orders keyframes by time, so both sides are put in the converter's full order first.
const cued = (keyframes: readonly DiagramMapKeyframe[]) =>
  keyframes
    .filter((k) => CUED_OPS.has(k.op))
    .sort((a, b) => a.atS - b.atS || a.op.localeCompare(b.op) || JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe("toDiagramMapTimeline", () => {
  // Catches: a mirror field renamed or dropped (e.g. minimap `on` as `enabled`), since the schema is strict.
  it("parses the copied titan-design fixture unchanged", () => {
    expect(DiagramMapTimelineSchema.parse(tdMapTimelineFixture)).toEqual(tdMapTimelineFixture);
  });

  // Catches: unmerged or missing spans, a wrong durS for an op, ids not carried over, or a dropped layoutSha.
  it("converts a storyboard telling the fixture's story into the fixture's spans and cued keyframes", () => {
    const fixture = DiagramMapTimelineSchema.parse(tdMapTimelineFixture);

    const converted = convert(fixtureStory);

    expect(DiagramMapTimelineSchema.parse(converted)).toEqual(converted);
    expect(converted.layoutSha).toBe(fixture.layoutSha);
    expect(converted.spans).toEqual(fixture.spans);
    expect(cued(converted.keyframes)).toEqual(cued(fixture.keyframes));
  });

  // Catches: keyframes emitted in segment order without the final sort (level would precede camera at 0 s).
  it("emits keyframes sorted by time, op and ids, the same whatever order the beat's fields are in", () => {
    const words = cueResolverFromWords({ "beat-01": [{ word: "Look", startS: 0 }, { word: "here", startS: 1 }] });
    const state = {
      minimap: true,
      pins: [{ anchor: "web", text: "entry", atCue: "here" }],
      reveal: [{ id: "web", atCue: "here" }, { id: "api", atCue: "here" }],
      camera: { station: "overview", atCue: "look" },
      level: "containers",
    };

    const keyframes = convert([mapBeat("beat-01", state)], words).keyframes;
    const shuffled = convert([mapBeat("beat-01", reverseAll(state) as Record<string, unknown>)], words).keyframes;

    expect(keyframes.map((k) => [k.atS, k.op])).toEqual([
      [0, "camera"],
      [0, "level"],
      [0, "minimap"],
      [1, "pin"],
      [1, "reveal"],
      [1, "reveal"],
    ]);
    expect(keyframes.filter((k) => k.op === "reveal").map((k) => "ids" in k && k.ids)).toEqual([["api"], ["web"]]);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(keyframes));
  });

  // Catches: a flow keyframe that drops speed, hop cue times or the until cue.
  it("carries a walk's speed and its hop and until cues as video seconds", () => {
    const words = cueResolverFromWords({ "beat-02": ["send", "web", "api", "done"].map((word, i) => ({ word, startS: 1 + 2 * i })) });
    const flow = { flow: "flow:create-note", fromHop: 1, toHop: 2, atCue: "send", hopCues: ["web", "api"], untilCue: "done" };

    const keyframes = convert([mapBeat("beat-01", { level: "containers" }), mapBeat("beat-02", { level: "containers", message_in_flight: flow })], words).keyframes;

    expect(keyframes.find((k) => k.op === "flow")).toEqual({
      atS: 11,
      durS: 0,
      op: "flow",
      flowId: "flow:create-note",
      fromHop: 1,
      toHop: 2,
      hopAtS: [13, 15],
      untilAtS: 17,
    });
  });

  // Catches: a camera box passed through as width and height, or an annotation anchor cut at its own colon.
  it("frames the camera through the resolver and keeps a colon inside an annotation anchor", () => {
    const words = cueResolverFromWords({ "beat-01": [{ word: "here", startS: 1 }] });
    const state = { level: "context", camera: { fit: ["actor:user"], atCue: "here" }, annotations: [{ kind: "circle", anchor: "actor:user", atCue: "here" }] };

    const keyframes = convert([mapBeat("beat-01", state)], words, () => ({ x: 10, y: 20, width: 320, height: 180 })).keyframes;

    expect(keyframes.filter((k) => k.op === "camera" || k.op === "annotate")).toEqual([
      { atS: 1, durS: 0.4, op: "annotate", anchor: "actor:user", mark: "circle" },
      { atS: 1, durS: 1, op: "camera", box: { x: 10, y: 20, w: 320, h: 180 } },
    ]);
  });

  it("refuses a camera move when no camera resolver is given", () => {
    const words = cueResolverFromWords({ "beat-01": [{ word: "here", startS: 1 }] });
    const timeline = compileMapTimeline([mapBeat("beat-01", { level: "context", camera: { station: "s", atCue: "here" } })], words);

    expect(() => toDiagramMapTimeline(timeline, { layoutSha: SHA })).toThrow(/cameraBox/);
  });
});

function reverseAll(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseAll).reverse();
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseAll(v)]));
}
