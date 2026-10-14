import { describe, expect, it } from "vitest";
import { deriveEvalView } from "./eval-view.js";
import { migrateTourV0 } from "./migrate.js";
import { tourProbe, tourV0 } from "./script-fixtures.test-helpers.js";

describe("migrateTourV0", () => {
  it("migrates every spike beat to a parseable script/v1", () => {
    const script = migrateTourV0(tourV0, tourProbe);

    expect(script).toMatchObject({ schema: "script/v1", id: "parcel-desk-passA", profile: "repo-tour" });
    expect(script.beats.map((b) => [b.id, b.function, b.mode])).toEqual([
      ["c1-1-hook", "HOOK", "explain"],
      ["c2-1-stations", "WHAT", "explain"],
      ["c2-2-cli", "HOW", "demo"],
      ["c2-3-outro", "CLOSE", "explain"],
    ]);
  });

  it("rebuilds the visual track from the probe's last shot", () => {
    const [hook, stations] = migrateTourV0(tourV0, tourProbe).beats;

    expect(hook?.visual).toMatchObject({
      assertion: "The desk refused its own label",
      chips: [{ kind: "illustrative", text: "illustrative parcel" }],
      labels: ["print_label"],
    });
    expect(stations?.visual).toMatchObject({
      job: "map",
      map_state: { level: "containers", visible: ["S1", "S2", "S3"] },
      labels: ["seen in the scan log", "Scanner", "Desk server", "Ledger"],
    });
  });

  it("writes TODO strings for fields the spike never had", () => {
    const script = migrateTourV0(tourV0, tourProbe);
    const outro = script.beats.at(-1);

    expect(script.video).toMatchObject({ promise: expect.stringMatching(/^TODO:/), close_type: expect.stringMatching(/^TODO:/) });
    expect(script.facts_pack).toMatch(/^TODO:/);
    expect(outro?.visual.assertion).toMatch(/^TODO:/);
    expect(outro?.visual.job).toMatch(/^TODO:/);
    expect(outro?.heldS).toBe(2);
  });

  it("labels each chapter with its station and question", () => {
    const labels = migrateTourV0(tourV0, tourProbe).chapters.map((c) => c.label);

    expect(labels).toEqual(["Cold open · Why refuse a label?", "S3 · Which part matters?"]);
  });

  it("derives an eval view for the migrated map beat", () => {
    const view = deriveEvalView(migrateTourV0(tourV0, tourProbe))[1]?.visual;

    expect(view).toMatchObject({ mode: "map", nodes_shown: ["S1", "S2", "S3"], state_changes: [] });
  });

  it("refuses a spike kind it has no beat function for", () => {
    const tour = { ...tourV0, beats: [{ ...tourV0.beats[0], kind: "confetti" }] };

    expect(() => migrateTourV0(tour, tourProbe)).toThrow('no beat function for spike kind "confetti"');
  });
});
