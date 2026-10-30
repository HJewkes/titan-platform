import { DEFAULT_OPTIONS, type Finding } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { contrastReport } from "../qa/contrast-check.js";
import { CONTRAST } from "../qa/gate-profile.js";
import { heldLowContrast, qaSamplings } from "../qa/layer-contrast.js";
import { badTextRows, contrastRows, distinctRows, layerTextHint, plannedCues, qaRows, revealMoments, type LayerTextRow } from "./layer-text.js";

// Synthetic: an invented parcel desk.
const AT = { x: 0, y: 0, w: 10, h: 10 };

describe("the moments the layer check reads", () => {
  it("places each cue word at its share of the planned seconds and reads it once it settles, then at the end", () => {
    const packet = { beat_id: "b1", spoken: "parcels wait at the desk", cues: [{ action: "V6" as const, target: "desk", atCue: "desk" }], planned_s: 10 };

    const cues = plannedCues(packet);

    expect(cues).toEqual({ desk: 8 });
    expect(revealMoments(cues, 10)).toEqual([9, 9.95]);
  });

  it("drops a cue the narration never speaks rather than guess its time", () => {
    const packet = { beat_id: "b1", spoken: "parcels wait", cues: [{ action: "V6" as const, target: "desk", atCue: "ledger" }], planned_s: 4 };

    expect(plannedCues(packet)).toEqual({});
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
  /** qa's samples of a 10 s beat with cues at 1 s and 6 s: start, enter, 1.9 s, the 5 s midpoint, 6.9 s and the end. */
  const SAMPLINGS = qaSamplings({ beats: [{ id: "b1", startS: 0, durationS: 10, cues: [{ name: "desk", atS: 1 }, { name: "scan", atS: 6 }] }] });
  const shownAt = (seconds: readonly number[], finding: Finding) => (t: number) => (seconds.includes(t) ? [finding] : []);

  it("the build check and qa's low-contrast gate agree on the same element", () => {
    // Arrange
    const held = heldLowContrast(SAMPLINGS, () => [WHITE_ON_AMBER]);

    // Act
    const rows = contrastRows(held);
    const { below } = contrastReport([], held, CONTRAST, DEFAULT_OPTIONS).text;

    // Assert
    expect(rows.map((row) => [row.element, row.text, row.contrast?.ratio])).toEqual([["div#count", "12", 2.04]]);
    expect(below.map((run) => [run.text, run.ratio])).toEqual([["12", 2.04]]);
  });

  it("a moving chip that qa does not hold is not rebuilt", () => {
    // Arrange
    const findingsAt = shownAt([1.9, 6.9], SLIDING_CHIP);

    // Act
    const rows = contrastRows(heldLowContrast(SAMPLINGS, findingsAt));

    // Assert
    expect(rows).toEqual([]);
  });

  it("holds text faint in two samples in a row, as qa does", () => {
    // Arrange
    const findingsAt = shownAt([1.9, 5], SLIDING_CHIP);

    // Act
    const rows = contrastRows(heldLowContrast(SAMPLINGS, findingsAt));

    // Assert
    expect(rows.map((row) => [row.text, row.atS])).toEqual([["cleared", 1.9]]);
  });

  it("tells the rebuild the text, its colour on its ground, the ratio and the on-accent fix", () => {
    // Arrange
    const rows = contrastRows(heldLowContrast(SAMPLINGS, () => [WHITE_ON_AMBER]));

    // Act
    const hint = layerTextHint(rows);

    // Assert
    expect(hint).toBe(
      "the last build broke qa's text rules: low-contrast on div#count \"12\" (#ffffff on #f5a524 is 2.04:1, under the 3:1 its size needs: "
        + "text on a filled shape uses that fill's on- text token, as var(--color-on-brand-primary) on var(--color-brand-primary-solid), or use a darker fill)",
    );
  });
});
