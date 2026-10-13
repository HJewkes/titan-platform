import { describe, expect, it } from "vitest";
import { lintMapBeats, type MapLintRule } from "./map-lints.js";
import { layout, mapBeat, offMap, reveal } from "./map-fixtures.test-helpers.js";
import type { MapBeat } from "./map-state.js";

const rules = (beats: MapBeat[]): MapLintRule[] => lintMapBeats(beats, layout).map((l) => l.rule);

describe("lintMapBeats", () => {
  it("accepts a storyboard that leaves the map for another slide type and comes back", () => {
    const beats = [
      mapBeat("beat-01", { level: "containers", reveal: reveal("web", "api") }),
      offMap("beat-02", "cast-in-motion"),
      mapBeat("beat-03", { level: "components", reveal: reveal("store") }),
    ];

    expect(lintMapBeats(beats, layout)).toEqual([]);
  });

  it("allows one level change per beat and rejects a jump of two", () => {
    const pass = [mapBeat("beat-01", { level: "context" }), mapBeat("beat-02", { level: "containers" })];
    const fail = [mapBeat("beat-01", { level: "context" }), mapBeat("beat-02", { level: "components" })];

    expect(rules(pass)).toEqual([]);
    expect(rules(fail)).toEqual(["level-step"]);
  });

  it("counts a level jump against the map's last level across an off-map beat", () => {
    const beats = [mapBeat("beat-01", { level: "context" }), offMap("beat-02"), mapBeat("beat-03", { level: "code" })];

    expect(rules(beats)).toEqual(["level-step"]);
  });

  it("allows three new boxes in a beat and rejects four", () => {
    const pass = [mapBeat("beat-01", { level: "containers", reveal: reveal("web", "api", "store") })];
    const fail = [mapBeat("beat-01", { level: "containers", reveal: reveal("web", "api", "store", "queue") })];

    expect(rules(pass)).toEqual([]);
    expect(rules(fail)).toEqual(["new-boxes"]);
  });

  it("does not count a box revealed by an earlier map beat as new", () => {
    const beats = [
      mapBeat("beat-01", { level: "containers", reveal: reveal("web", "api", "store") }),
      offMap("beat-02"),
      mapBeat("beat-03", { level: "containers", reveal: reveal("web", "api", "store", "queue") }),
    ];

    expect(rules(beats)).toEqual([]);
  });

  it("allows seven full-weight boxes and rejects eight unless a focus narrows them", () => {
    const run = (last: string[], extra: Record<string, unknown> = {}) => [
      mapBeat("beat-01", { level: "containers", reveal: reveal("web", "api", "store") }),
      mapBeat("beat-02", { level: "containers", reveal: reveal("queue", "worker", "auth") }),
      mapBeat("beat-03", { level: "containers", reveal: reveal(...last), ...extra }),
    ];
    const focusApi = { focus: { ids: ["api"], atCue: "here" } };

    expect(rules(run(["cache"]))).toEqual([]);
    expect(rules(run(["cache", "billing"]))).toEqual(["full-weight"]);
    expect(rules(run(["cache", "billing"], focusApi))).toEqual([]);
  });

  it("rejects a node or edge id the layout does not have", () => {
    const pass = [mapBeat("beat-01", { level: "containers", reveal: reveal("web"), edges: [{ id: "web->api", atCue: "go" }] })];
    const fail = [mapBeat("beat-01", { level: "containers", reveal: reveal("ghost"), edges: [{ id: "web->ghost", atCue: "go" }] })];

    expect(rules(pass)).toEqual([]);
    expect(rules(fail)).toEqual(["unknown-id", "unknown-id"]);
  });

  it("rejects drawing an edge whose layout edge has no edgeSource", () => {
    const pass = [mapBeat("beat-01", { level: "containers", edges: [{ id: "api->store", atCue: "go" }] })];
    const fail = [mapBeat("beat-01", { level: "containers", edges: [{ id: "api->queue", atCue: "go" }] })];

    expect(rules(pass)).toEqual([]);
    expect(rules(fail)).toEqual(["edge-source"]);
  });

  it("rejects a hand layout without an our-framing chip, on or off the map", () => {
    const pass = [offMap("beat-01"), mapBeat("beat-02", { level: "context" }, { layout_source: "hand", chips: ["our-framing"] })];
    const fail = [mapBeat("beat-01", undefined, { layout_source: "hand" })];

    expect(rules(pass)).toEqual([]);
    expect(rules(fail)).toEqual(["hand-framing"]);
  });

  it("allows one card entering per cue and rejects two on the same cue", () => {
    const card = (ref: string, atCue: string) => ({ ref, atCue, untilCue: null });
    const pass = [mapBeat("beat-01", { level: "components", cards: [card("api-card", "here"), card("store-card", "there")] })];
    const fail = [mapBeat("beat-01", { level: "components", cards: [card("api-card", "here"), card("store-card", "here")] })];

    expect(rules(pass)).toEqual([]);
    expect(rules(fail)).toEqual(["card-per-cue"]);
  });

  it("warns, never errors, when a zoom has no later return to the map", () => {
    const pass = [offMap("beat-01", "zoom"), mapBeat("beat-02", { level: "containers" })];
    const fail = [mapBeat("beat-01", { level: "containers" }), offMap("beat-02", "zoom")];

    expect(lintMapBeats(pass, layout)).toEqual([]);
    expect(lintMapBeats(fail, layout)).toEqual([expect.objectContaining({ rule: "return-to-map", severity: "warning", beatId: "beat-02" })]);
  });
});
