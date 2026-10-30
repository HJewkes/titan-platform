import { classify, DEFAULT_OPTIONS, type Finding } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { contrastReport } from "../qa/contrast-check.js";
import { CONTRAST } from "../qa/gate-profile.js";
import { heldAtSamples, layerSamplings } from "../qa/layer-contrast.js";
import { qaSampleMoments } from "../qa/qa-timeline.js";
import { badTextRows, distinctRows, heldRows, layerTextHint, qaRows, revealMoments, type LayerTextRow } from "./layer-text.js";

// Synthetic: an invented parcel desk.
const AT = { x: 0, y: 0, w: 10, h: 10 };

describe("the moments the layer check reads", () => {
  it("reads each cue word once it settles, then at the end", () => {
    expect(revealMoments({ desk: 8 }, 10)).toEqual([9, 9.95]);
  });
});

describe("the layer check's rows", () => {
  it("keeps qa's small-text and under-chrome findings and no other kind", () => {
    const findings = [
      { kind: "small-text", el: "div.label", text: "held", at: AT },
      { kind: "low-contrast", el: "div.dim", text: "faint", at: AT },
      { kind: "under-chrome", el: "div.foot", text: "last scan", at: AT },
    ];

    const rows = qaRows("b1", 2, findings);

    expect(rows.map((row) => [row.rule, row.element])).toEqual([["small-text", "div.label"], ["under-chrome", "div.foot"]]);
  });

  it("flags NaN, undefined, null and [object as bad text, and leaves words that only contain them", () => {
    const texts = ["NaN parcels", "undefined", "owner: null", "[object Object]", "Nanaimo depot", "nullable field"]
      .map((text) => ({ text, px: 48, tag: "div", cls: "", element: "div", lines: [], clips: [] }));

    const rows = badTextRows("b1", [{ t: 1, texts }]);

    expect(rows.map((row) => row.text)).toEqual(["NaN parcels", "undefined", "owner: null", "[object Object]"]);
  });

  it("keeps one row per element, rule and text, at its earliest moment", () => {
    const row = (atS: number): LayerTextRow => ({ beat: "b1", element: "span", rule: "bad-text", text: "NaN", atS });

    expect(distinctRows([row(3), row(1), row(2)])).toEqual([row(1)]);
  });

  it("tells the rebuild each element, its text and the fix for its rule", () => {
    const hint = layerTextHint([{ beat: "b1", element: "div.label", rule: "small-text", text: "held", atS: 1 }]);

    expect(hint).toBe("the last build broke qa's text rules: small-text on div.label \"held\" (draw it at 40 px or larger)");
  });
});

describe("the rebuild hint for qa's narration rules", () => {
  it("tells the rebuild which number the narration never says", () => {
    // Arrange
    const row: LayerTextRow = { beat: "b1", element: "div#more", rule: "unspoken-fact", text: "+ 4 late scans", atS: 9.95, fact: "4" };

    // Act
    const hint = layerTextHint([row]);

    // Assert
    expect(hint).toBe("the last build broke qa's text rules: unspoken-fact on div#more \"+ 4 late scans\" (the narration never says 4: draw no number or name the narration does not say; drop it or show only what is spoken)");
  });
});

describe("the layer check's contrast rows", () => {
  /** White on an amber bar as qa's in-page low-contrast rule reports it. */
  const WHITE_ON_AMBER: Finding = { kind: "low-contrast", el: "div#count", text: "12", px: 56, ratio: 2.04, need: 3, fg: "#ffffff", bg: "#f5a524", at: AT };
  /** A chip that slides across the stage, faint only where qa catches it mid-slide. */
  const SLIDING_CHIP: Finding = { kind: "low-contrast", el: "div.chip", text: "cleared", px: 40, ratio: 2.35, need: 3, fg: "#3a7a5a", bg: "#32302e", at: AT };
  /** A 10 s beat with cues at 1 s and 6 s: qa's cue moments are start, enter, 1.9 s, the 5 s midpoint, 6.9 s and the end. */
  const TIMELINE = { beats: [{ id: "b1", startS: 0, durationS: 10, cues: [{ name: "desk", atS: 1 }, { name: "scan", atS: 6 }] }] };
  /** What the build check reads: qa's samplings, then its sweep at every 2 Hz phase the voiced start may land on. */
  const SAMPLINGS = layerSamplings(TIMELINE);
  /** qa's own samplings of the beat as planned: the cue moments, then those with the 2 Hz sweep. */
  const QA_SAMPLINGS = [qaSampleMoments(TIMELINE, false), qaSampleMoments(TIMELINE, true)];
  const shownAt = (seconds: readonly number[], finding: Finding) => (t: number) => (seconds.includes(t) ? [finding] : []);
  /** A stage full of content, so late-fill holds nothing and only the findings given are judged. */
  const filled = (findingsAt: (t: number) => Finding[]) => (t: number) => ({ contentRuns: 3, findings: findingsAt(t) });

  it("the build check and qa's low-contrast gate agree on the same element", () => {
    // Arrange
    const held = heldAtSamples(TIMELINE, SAMPLINGS, filled(() => [WHITE_ON_AMBER]));

    // Act
    const rows = heldRows(held);
    const { below } = contrastReport([], held, CONTRAST, DEFAULT_OPTIONS).text;

    // Assert
    expect(rows.map((row) => [row.element, row.text, row.contrast?.ratio])).toEqual([["div#count", "12", 2.04]]);
    expect(below.map((run) => [run.text, run.ratio])).toEqual([["12", 2.04]]);
  });

  // catches: a build check that keeps only held contrast errors, which qa's contrast report fails on one transient sample
  it("text under contrast on one sample between qa's 2 Hz ticks gets a rebuild", () => {
    // Arrange
    const findingsAt = shownAt([2.2], SLIDING_CHIP);

    // Act
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, filled(findingsAt)));

    // Assert
    expect(rows.map((row) => [row.rule, row.text, row.atS])).toEqual([["low-contrast", "cleared", 2.2]]);
  });

  // catches: a build check that reads qa's sweep only at the planned phase, so a voiced start that moves it refuses the card
  it("an off-frame box held at some 2 Hz phase is refused at any beat start", () => {
    // Arrange
    const card: Finding = { kind: "off-frame", el: "div.lane", text: "Deploy", at: AT };
    const findingsAt = (t: number) => (t >= 2.15 && t <= 2.75 ? [card] : []);
    const atPlannedPhase = QA_SAMPLINGS.flatMap((moments) => classify(moments.map((m) => ({ ...m, contentRuns: 0, findings: findingsAt(m.t) }))).errors);

    // Act
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, filled(findingsAt)));

    // Assert
    expect(atPlannedPhase).toEqual([]);
    expect(rows.map((row) => [row.rule, row.element, row.atS])).toEqual([["off-frame", "div.lane", 2.2]]);
  });

  it("holds text faint in two samples in a row, as qa does", () => {
    // Arrange
    const findingsAt = shownAt([1.9, 5], SLIDING_CHIP);

    // Act
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, filled(findingsAt)));

    // Assert
    expect(rows.map((row) => [row.text, row.atS])).toEqual([["cleared", 1.9]]);
  });

  it("tells the rebuild the text, its colour on its ground, the ratio and the on-accent fix", () => {
    // Arrange
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, filled(() => [WHITE_ON_AMBER])));

    // Act
    const hint = layerTextHint(rows);

    // Assert
    expect(hint).toBe(
      "the last build broke qa's text rules: low-contrast on div#count \"12\" (#ffffff on #f5a524 is 2.04:1, under the 3:1 its size needs: "
        + "text on a filled shape uses that fill's on- text token, as var(--color-on-brand-primary) on var(--color-brand-primary-solid), or use a darker fill)",
    );
  });

  // catches: a build check that holds only low-contrast at qa's samples, so qa refuses an off-frame card the build passed
  it("the layer build check holds off-frame the same way qa does", () => {
    // Arrange
    const card: Finding = { kind: "off-frame", el: "div.lane", text: "Deploy", at: AT };
    const passing: Finding = { kind: "off-frame", el: "div.chip", text: "cleared", at: AT };
    const findingsAt = (t: number) => [...shownAt([1.9, 5], card)(t), ...shownAt([6.9], passing)(t)];
    const qaHeld = QA_SAMPLINGS.flatMap((moments) => classify(moments.map((m) => ({ ...m, contentRuns: 0, findings: findingsAt(m.t) }))).errors);

    // Act
    const rows = heldRows(heldAtSamples(TIMELINE, SAMPLINGS, filled(findingsAt)));

    // Assert
    expect(rows.map((row) => [row.rule, row.element, row.atS])).toEqual([["off-frame", "div.lane", 1.9]]);
    expect([...new Set(qaHeld.map((held) => held.finding.el))]).toEqual(["div.lane"]);
    expect(layerTextHint(rows)).toContain("off-frame on div.lane \"Deploy\" (keep every painted part inside the 1920 by 1080 frame");
  });
});
