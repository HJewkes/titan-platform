import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScriptSchema } from "./script-schema.js";
import { fromSpikeScript, readSpikeScript } from "./spike-script.js";
import { v4Script } from "./spike-fixtures.test-helpers.js";

describe("reading a spike script.json", () => {
  // Mutation: reading the spike through ScriptSchema instead of the loose schema throws on the v4 fixture.
  it("reads the v4 script that the strict ScriptSchema still rejects", () => {
    expect(ScriptSchema.safeParse(v4Script()).success).toBe(false);

    const { script } = readSpikeScript(v4Script());

    expect(script.beats).toHaveLength(20);
    expect(script.beats[0]).toMatchObject({ id: "r1-1-hook", origin: "v2", visual: { render: "HookBeat" } });
  });

  // Mutation: reporting only top-level keys hides the beat and map_state fields the reader skips.
  it("names every field it ignores, at every depth, and none it reads", () => {
    const { ignored } = readSpikeScript(v4Script());

    expect(ignored).toEqual(
      expect.arrayContaining([
        "video.audience",
        "video.stake",
        "video.map",
        "chapters",
        "beats[].band",
        "beats[].connector_in",
        "beats[].visual.chips",
        "beats[].visual.recipe",
        "beats[].visual.cues[].action",
        "beats[].visual.map_state.item",
        "beats[].visual.map_state.old.focus",
        "maps.*.nodeBox",
      ]),
    );
    expect(ignored).not.toContain("video");
    expect(ignored).not.toContain("video.invariants");
    expect(ignored).not.toContain("beats[].origin");
    expect(ignored).not.toContain("beats[].visual.render");
    expect(ignored).not.toContain("beats[].visual.map_state.old");
  });

  // Mutation: labelling reveals by node id gives "backlog", not the map's "Backlog".
  it("labels map reveals from the script's map nodes, and reads both sides of a split map", () => {
    const { beats } = fromSpikeScript(v4Script());
    const items = (id: string) => beats.find((b) => b.id === id)?.items.map((i) => i.label);

    expect(items("r1-3-stores")?.slice(0, 3)).toEqual(["Backlog", "Tick", "Broker"]);
    expect(items("r5-1-holds")).toEqual(["two hold slots", "set per head"]);
    expect(beats.find((b) => b.id === "r5-1-holds")).toMatchObject({ mapBeside: true, render: "SplitMapBeat" });
  });

  // Mutation: not reading `video` leaves the seated-invariant lint no phrases to match.
  it("hands the script's video invariants to a caller of the item track", () => {
    const { invariants } = fromSpikeScript(v4Script());

    expect(invariants).toHaveLength(7);
    expect(invariants).toContain("State survives restarts.");
  });

  // Mutation: dropping the default makes a script with no `video` block hand back undefined.
  it("hands back no invariants when the script has no video block", () => {
    const { video, ...noVideo } = z.looseObject({ video: z.unknown() }).parse(v4Script());

    expect(video).toBeDefined();
    expect(fromSpikeScript(noVideo).invariants).toEqual([]);
  });

  // Mutation: returning only the beats from fromSpikeScript leaves a caller nothing to report.
  it("hands the ignored fields to a caller of the item track", () => {
    const { ignored } = fromSpikeScript(v4Script());

    expect(ignored).toEqual(readSpikeScript(v4Script()).ignored);
    expect(ignored).toContain("beats[].band");
  });
});
