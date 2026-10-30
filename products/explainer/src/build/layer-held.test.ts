import { classify, ERROR_KINDS, type Finding } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { loadTypeProfiles } from "../profile-load.js";
import { loadQaGate } from "../qa/gate-profile.js";
import { heldAtSamples, layerSamplings } from "../qa/layer-contrast.js";
import { qaSampleMoments } from "../qa/qa-timeline.js";
import { heldRows, layerTextHint } from "./layer-text.js";

// Synthetic: an invented parcel desk, two panels side by side.
/** What the check reads of one inspected frame. */
interface LayerInspection {
  contentRuns: number;
  findings: Finding[];
}
const PANEL = { x: 680, y: 550, w: 560, h: 320 };
/** A fixed 560 by 320 panel whose second chip wraps to two lines and runs past the panel's bottom. */
const OVERFLOWING_PANEL: Finding = { kind: "content-overflow", el: "div#shelf-2", text: "ShelfReturned parcels", dx: -40, dy: 19, at: PANEL };
/** A 10 s beat with cues at 1 s and 6 s: qa's cue moments are start, enter, 1.9 s, the 5 s midpoint, 6.9 s and the end. */
const TIMELINE = { beats: [{ id: "b1", startS: 0, durationS: 10, cues: [{ name: "desk", atS: 1 }, { name: "scan", atS: 6 }] }] };
const SAMPLINGS = layerSamplings(TIMELINE);
/** qa's own samplings of the beat as planned: the cue moments, then those with the 2 Hz sweep. */
const QA_SAMPLINGS = [qaSampleMoments(TIMELINE, false), qaSampleMoments(TIMELINE, true)];

/** A stage full of content from `fromS` on, showing `finding` there; only that finding can be judged. */
const shownFrom = (fromS: number, finding: Finding) => (t: number): LayerInspection => ({ contentRuns: 3, findings: t >= fromS ? [finding] : [] });

/** What qa's own gate holds of the same frames, with every kind it can hold gated. */
const qaHeldKinds = (inspectionAt: (t: number) => LayerInspection): string[] =>
  QA_SAMPLINGS.flatMap((moments) => classify(moments.map((m) => ({ ...m, ...inspectionAt(m.t), findings: [...inspectionAt(m.t).findings] }))).errors.map(({ kind }) => kind));

describe("the layer check's held rules", () => {
  // catches: a build check that runs only some of qa's held rules, so a panel qa refuses for overflow passes the build (TP-4606)
  it("refuses a fixed panel whose wrapped label overflows it, as qa does", () => {
    // Arrange
    const inspectionAt = shownFrom(6.9, OVERFLOWING_PANEL);

    // Act
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, inspectionAt));

    // Assert
    expect(qaHeldKinds(inspectionAt)).toContain("content-overflow");
    expect(rows.map((row) => [row.rule, row.element, row.text])).toEqual([["content-overflow", "div#shelf-2", "ShelfReturned parcels"]]);
    expect(layerTextHint(rows)).toContain("content-overflow on div#shelf-2 \"ShelfReturned parcels\" (fit the content inside its box: no fixed height around text that can wrap");
  });

  it("passes an overflow seen on one sample mid-entrance, which qa does not hold either", () => {
    // Arrange
    const inspectionAt = (t: number): LayerInspection => ({ contentRuns: 3, findings: t === 1.9 ? [OVERFLOWING_PANEL] : [] });

    // Act
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, inspectionAt));

    // Assert
    expect(qaHeldKinds(inspectionAt)).toEqual([]);
    expect(rows).toEqual([]);
  });

  // catches: a build check that reads a cue's pulse only where its estimated clock puts qa's samples, so qa refuses it on the real voice (TP-4617)
  it("refuses text a pulse covers for half a second after a cue word, which qa holds once its samples land on the pulse", () => {
    // Arrange
    const occluded: Finding = { kind: "occluded", el: "div#shelf-2", text: "Returned", at: PANEL };
    const pulseAfter = (cueS: number) => (t: number): LayerInspection => ({ contentRuns: 3, findings: t >= cueS && t < cueS + 0.5 ? [occluded] : [] });
    const estimated = { beats: [{ id: "b1", startS: 0, durationS: 10, cues: [{ name: "desk", atS: 1 }, { name: "scan", atS: 2.2 }] }] };
    const voiced = { beats: [{ id: "b1", startS: 0, durationS: 10, cues: [{ name: "desk", atS: 1 }, { name: "scan", atS: 1.775 }] }] };
    const qaOnVoice = classify(qaSampleMoments(voiced, true).map((m) => ({ ...m, contentRuns: 3, findings: [...pulseAfter(1.775)(m.t).findings] })));

    // Act
    const rows = heldRows(heldAtSamples(estimated, layerSamplings(estimated), pulseAfter(2.2)));

    // Assert
    expect(qaOnVoice.errors.map(({ kind }) => kind)).toEqual(["occluded"]);
    expect(rows.map((row) => [row.rule, row.text])).toEqual([["occluded", "Returned"]]);
    expect(layerTextHint(rows)).toContain("(draw nothing over text");
  });

  // catches: a build check that never adds late-fill, which qa adds from the beat's cues before it holds anything
  it("refuses a stage still empty past a third of the beat with a cue to come", () => {
    // Arrange
    const inspectionAt = (t: number): LayerInspection => ({ contentRuns: t >= 6 ? 3 : 1, findings: [] });

    // Act
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, inspectionAt));

    // Assert
    expect(rows.map((row) => row.rule)).toEqual(["late-fill"]);
    expect(layerTextHint(rows)).toContain("(show content early");
  });
});

/** Every kind any qa gate profile holds, by default or for a video type, and every kind render-qa can gate. */
const QA_HELD_KINDS = [...new Set<string>([...ERROR_KINDS, ...[undefined, ...loadTypeProfiles().keys()].flatMap((type) => loadQaGate(type).gate)])];

describe("the layer check and qa's gate hold the same kinds", () => {
  // catches: a kind qa's gate holds that the build check never runs, drops from its rows, or tells a rebuild nothing about
  it.each(QA_HELD_KINDS)("turns a held %s finding into a rebuild row with a fix", (kind) => {
    // Arrange
    const finding: Finding = { kind, el: "div#shelf-2", text: "Returned parcels", orphan: true, at: PANEL };

    // Act
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, shownFrom(1.9, finding)));

    // Assert
    expect(rows.map((row) => row.rule)).toEqual([kind]);
    expect(layerTextHint(rows)).toMatch(new RegExp(`^the last build broke qa's text rules: ${kind} on div#shelf-2 "Returned parcels" \\(\\w`));
  });
});
