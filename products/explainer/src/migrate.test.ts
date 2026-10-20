import { describe, expect, it } from "vitest";
import { deriveEvalView } from "./eval-view.js";
import { runL0 } from "./eval-l0.js";
import { migrateSpike, migrateTourV0 } from "./migrate.js";
import { tourProbe, tourV0 } from "./script-fixtures.test-helpers.js";
import { pipelineScript, v4FullScript } from "./spike-fixtures.test-helpers.js";

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

describe("migrateSpike", () => {
  const failing = (script: unknown, checkId: string): string[] =>
    runL0(migrateSpike(script)).find((row) => row.check_id === checkId)?.detail_beats ?? [];

  // Mutation: dropping cue targets in the migration leaves r2-1 with no items, so Q-E7 passes it and this fails.
  it("migrates the whole v4 spike script, and L0 then flags the same beats as eval pace", () => {
    const script = migrateSpike(v4FullScript());

    expect(script.beats).toHaveLength(75);
    expect(failing(v4FullScript(), "Q-E7")).toEqual(expect.arrayContaining(["r2-1-jobs", "r2-2-inv"]));
  });

  it("migrates the pipeline-explainer, and L0 names the frozen Q-E7 set", () => {
    expect(failing(pipelineScript(), "Q-E7")).toEqual(["c5-1-contract", "c6-10-rule"]);
  });

  it("keeps the spike keys ScriptSchema admits", () => {
    const [hook] = migrateSpike(v4FullScript()).beats;

    expect(hook).toMatchObject({ band: "hook", origin: "v2", visual: { render: "HookBeat" } });
    expect(hook?.visual.cues).toHaveLength(2);
  });

  it("maps spike chip kinds and a connector onto script/v1's", () => {
    const beats = migrateSpike(v4FullScript()).beats;
    const kinds = new Set(beats.flatMap((beat) => beat.visual.chips.map((chip) => chip.kind)));

    expect(kinds).toEqual(new Set(["verified", "inferred", "our-framing", "docs-claim"]));
    expect(new Set(beats.flatMap((beat) => (beat.connector_in ? [beat.connector_in] : [])))).toEqual(new Set(["and", "so", "but"]));
  });

  it("drops a generic model of more than five slots rather than truncating it", () => {
    const script = migrateSpike(v4FullScript());

    expect(script.video.generic_model).toBeUndefined();
    expect(script.video.invariants).toHaveLength(7);
  });

  it("still fails on a key it does not know", () => {
    const script = pipelineScript() as { beats: Record<string, unknown>[] };
    const odd = { ...script, beats: script.beats.map((beat, i) => (i === 0 ? { ...beat, sparkle: true } : beat)) };

    expect(() => migrateSpike(odd)).toThrow(/sparkle/);
  });
});
