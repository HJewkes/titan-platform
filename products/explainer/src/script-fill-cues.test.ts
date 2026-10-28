import { describe, expect, it } from "vitest";
import { emphasisTargets, loadBeatSpecs } from "./beat-load.js";
import { dailyScript } from "./daily-script.test-helpers.js";
import { draftFill, draftFillFaults, fillHint, fillRows } from "./script-fill.js";
import type { ScriptV1 } from "./script-schema.js";
import { SIM_BEAT } from "./sim/sim-resolve.js";
import { FillError } from "./template-fill/fill.js";

// Synthetic: the invented parcel floor's day from the daily fixture; no label or cue quotes a real run.
type Cue = ScriptV1["beats"][number]["visual"]["cues"][number];
const cue = (target: string, atCue: string): Cue => ({ action: "V6", target, atCue });
const UNCALLED = ["The router lane holds", "Matcher rewrite merged clean", "No refusals since noon"];
const NO_CALL = "verdict-card has no call: no `<call>: …` first label and no chip";

/** The daily with one beat's visual fields replaced. */
function withBeat(id: string, patch: Partial<ScriptV1["beats"][number]["visual"]>): ScriptV1 {
  const script = dailyScript();
  return { ...script, beats: script.beats.map((beat) => (beat.id === id ? { ...beat, visual: { ...beat.visual, ...patch } } : beat)) };
}

describe("cue targets at the script stage's template fill", () => {
  it("faults a verdict card that falls back to a list, naming the fallback's cause, the cues it orphans and the list's elements", () => {
    // Arrange
    const draft = withBeat("bottom-line-1", { labels: UNCALLED });

    // Act
    const faults = draftFillFaults(draft);

    // Assert
    expect(faults).toEqual([
      `template fill: bottom-line-1 (verdict-card): cue targets reasons-1, reasons-2 name no one element of the list it falls back to (${NO_CALL}); its elements are rows-1, rows-2, rows-3`,
    ]);
  });

  it("passes the same fallback once its cues point at the list's rows", () => {
    // Arrange
    const draft = withBeat("bottom-line-1", { labels: UNCALLED, cues: [cue("rows-2", "clean"), cue("rows-3", "noon")] });

    // Act
    const faults = draftFillFaults(draft);

    // Assert
    expect(faults).toEqual([]);
  });

  it("faults a cue past a chart's last series on a beat that fills its own spec", () => {
    // Arrange
    const draft = withBeat("lanes-4", { cues: [cue("series-1", "monday"), cue("series-9", "today")] });

    // Act
    const faults = draftFillFaults(draft);

    // Assert
    expect(faults).toEqual(["template fill: lanes-4 (chart): cue targets series-9 name no one element of chart; its elements are series-1, series-2, series-3, series-4"]);
  });

  it("gives the repair round an error row for the beat and a hint naming its fallback and orphaned cues", () => {
    // Arrange
    const draft = withBeat("bottom-line-1", { labels: UNCALLED });

    // Act
    const rows = fillRows(draft);
    const hint = fillHint(draft, ["bottom-line-1"]);

    // Assert
    expect(rows).toMatchObject([{ check_id: "template-fill", severity: "error", pass: false, detail_beats: ["bottom-line-1"] }]);
    expect(hint).toContain(`the list it falls back to (${NO_CALL})`);
    expect(hint).toContain("cue targets reasons-1, reasons-2");
  });
});

/** The daily's goals beat drawn as `type`, on two plain labels and a cue on the first id of the spec's first target list. */
function drawnAs(type: string, field: string): ScriptV1 {
  return withBeat("goals-1", { beat: type, labels: ["Two lanes", "One queue"], chips: [], cues: [cue(`${field}-1`, "matches")] });
}

describe("every fallback the registry allows, at the script stage", () => {
  it("leaves no cue the original kind would light orphaned on its fallback without a script-stage fault, but a sim resolve cuts", () => {
    // Arrange
    const specs = loadBeatSpecs();
    const cued = [...specs.values()].flatMap((spec) => (spec.emphasis?.targets[0] ? [{ type: spec.type, field: spec.emphasis.targets[0] }] : []));

    // Act
    const outcomes = cued.flatMap(({ type, field }) => {
      const draft = drawnAs(type, field);
      const filled = draftFill(draft, specs);
      const beat = filled instanceof FillError ? undefined : filled.beats.find((b) => b.id === "goals-1");
      if (beat?.fallback === undefined) return [];
      // A sim that falls back has nothing to sweep, so resolve cuts it before its cues are drawn.
      const orphaned = type !== SIM_BEAT && !emphasisTargets(specs.get(beat.spec)!, beat.slots).includes(`${field}-1`);
      return [{ pair: `${type} → ${beat.spec}`, orphaned, reported: draftFillFaults(draft).some((fault) => fault.startsWith("template fill: goals-1 ")) }];
    });

    // Assert
    expect(outcomes.length).toBeGreaterThan(10);
    expect(outcomes.filter((o) => o.orphaned).map((o) => o.pair)).toContain("verdict-card → list");
    expect(outcomes.filter((o) => o.orphaned && !o.reported)).toEqual([]);
  });
});
