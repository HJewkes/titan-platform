import { describe, expect, it } from "vitest";
import { dailyScript, SIDE_QUEST_LABELS } from "./daily-script.test-helpers.js";
import { draftFillFaults, draftTemplateFill } from "./script-fill.js";
import type { ScriptV1 } from "./script-schema.js";

// Synthetic: the invented parcel floor's day from the daily fixture; no label quotes a real run.
const SIDE_QUESTS_SEVEN = [...SIDE_QUEST_LABELS, "ops · Spare printer set up", "docs · Glossary trimmed", "test · Slow case split", "ops · Old branch parked"];
const STATS_SEVEN = ["9 merges", "12 lanes", "5 in review", "3 reverts", "2 drafts", "1 alarm", "4 docs"];

/** The daily with its stats beat drawn as a metrics-panel, which derives no slots and so falls back to a list. */
function metricsPanel(labels: string[]): ScriptV1 {
  const script = dailyScript();
  return { ...script, beats: script.beats.map((beat) => (beat.id === "stats-1" ? { ...beat, visual: { ...beat.visual, beat: "metrics-panel", labels } } : beat)) };
}

describe("the script stage's template fill on its own draft", () => {
  it("passes the synthetic daily, whose every list holds at most five labels", () => {
    // Arrange
    const draft = dailyScript();

    // Act
    const verdict = draftTemplateFill(draft);

    // Assert
    expect(verdict).toEqual({ pass: true, detail: "every beat fills its beat spec" });
  });

  it("names a side-quests list of 7 labels and the slot schema's cap of five rows", () => {
    // Arrange
    const draft = dailyScript({ "side-quests-1": SIDE_QUESTS_SEVEN });

    // Act
    const faults = draftFillFaults(draft);

    // Assert
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/^template fill: side-quests-1 \(list\): .*<=5 items/);
  });

  it("passes the same side-quests list cut to 5 labels", () => {
    // Arrange
    const draft = dailyScript({ "side-quests-1": SIDE_QUESTS_SEVEN.slice(0, 5) });

    // Act
    const faults = draftFillFaults(draft);

    // Assert
    expect(faults).toEqual([]);
  });

  it("faults a metrics-panel beat of 7 labels through its list fallback, and passes one of 4 as that fallback", () => {
    // Arrange
    const seven = metricsPanel(STATS_SEVEN);
    const four = metricsPanel(STATS_SEVEN.slice(0, 4));

    // Act
    const [overflow, fits] = [draftTemplateFill(seven), draftTemplateFill(four)];

    // Assert
    expect(overflow.pass).toBe(false);
    expect(overflow.detail).toMatch(/^template fill: stats-1 \(metrics-panel\): .*derives no slots.*the list fallback is invalid too: .*<=5 items/);
    expect(fits.pass).toBe(true);
  });

  it("leaves a companion card to resolve, which fills it from the chapter links whatever its labels", () => {
    // Arrange
    const script = dailyScript({ "reflection-2": SIDE_QUESTS_SEVEN });
    const draft = { ...script, beats: script.beats.map((beat) => (beat.id === "reflection-2" ? { ...beat, visual: { ...beat.visual, beat: "companion-link" } } : beat)) };

    // Act
    const faults = draftFillFaults(draft);

    // Assert
    expect(faults).toEqual([]);
  });

  it("leaves a code beat to resolve, which holds the cited code its slots read", () => {
    // Arrange
    const script = dailyScript({ "side-quests-1": SIDE_QUESTS_SEVEN });
    const draft = { ...script, beats: script.beats.map((beat) => (beat.id === "side-quests-1" ? { ...beat, visual: { ...beat.visual, beat: "code-walk" } } : beat)) };

    // Act
    const faults = draftFillFaults(draft);

    // Assert
    expect(faults).toEqual([]);
  });
});
