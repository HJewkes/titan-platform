import { describe, expect, it } from "vitest";
import { dailyWith } from "./daily-script.test-helpers.js";
import { runL0 } from "./eval-l0.js";
import { cueGapCheck } from "./lint-cadence.js";
import { dropOrphanCues } from "./orphan-cues.js";
import { draftFillFaults } from "./script-fill.js";
import type { ScriptV1 } from "./script-schema.js";
import { failingErrors } from "./workflow/script-draft.js";

// Synthetic: the invented parcel floor's day from the daily fixture; no narration or cue quotes a real run.
const cue = (target: string, atCue: string) => ({ action: "V6" as const, target, atCue });
const cueGapRows = (script: ScriptV1) => failingErrors(runL0(script, undefined, [cueGapCheck]));
const cuesOf = (script: ScriptV1, id: string) => script.beats.find((beat) => beat.id === id)!.visual.cues.map((each) => each.target);

const LONG =
  "Across the week merges climbed from four on the first morning through six and seven, the docs lane renamed two pages midweek, and nine landed today at the close of the parcel floor shift.";
const longChart = (cues: ReturnType<typeof cue>[]) => dailyWith("lanes-4", { spoken: LONG, plannedS: 16, visual: { cues } });

describe("orphan cue targets before the plan check", () => {
  it("a cue on an element the fill does not draw is dropped when the rest still pass", () => {
    // Arrange
    const draft = dailyWith("lanes-4", { visual: { cues: [cue("series-1", "monday"), cue("series-9", "today")] } });

    // Act
    const { script, moves } = dropOrphanCues(draft, cueGapRows);

    // Assert
    expect(cuesOf(script, "lanes-4")).toEqual(["series-1"]);
    expect(draftFillFaults(script)).toEqual([]);
    expect(moves).toEqual(["orphan cue dropped: lanes-4 series-9 (names no element the fill draws)"]);
  });

  it("a drop that opens a Q-D17 cue gap is refused, so the repair re-aims the cue", () => {
    // Arrange
    const draft = longChart([cue("series-1", "across"), cue("series-9", "renamed")]);
    const opened = cueGapRows(longChart([cue("series-1", "across")]));

    // Act
    const { script, moves } = dropOrphanCues(draft, cueGapRows);

    // Assert
    expect(opened.map((row) => row.check_id)).toEqual(["Q-D17"]);
    expect(cueGapRows(draft)).toEqual([]);
    expect(cuesOf(script, "lanes-4")).toEqual(["series-1", "series-9"]);
    expect(moves).toEqual([]);
  });

  it("a beat whose every cue is orphaned keeps them for the repair", () => {
    // Arrange
    const draft = dailyWith("lanes-4", { visual: { cues: [cue("series-8", "monday"), cue("series-9", "today")] } });

    // Act
    const { script, moves } = dropOrphanCues(draft, cueGapRows);

    // Assert
    expect(cuesOf(script, "lanes-4")).toEqual(["series-8", "series-9"]);
    expect(moves).toEqual([]);
  });
});
