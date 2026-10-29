import { describe, expect, it } from "vitest";
import { badTextRows, distinctRows, layerTextHint, narrationRows, plannedCues, qaRows, revealMoments, type LayerTextRow } from "./layer-text.js";

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

describe("qa's narration rules on a layer's text", () => {
  const text = (element: string, shown: string) => ({ text: shown, px: 48, tag: "div", cls: "", element, lines: [], clips: [] });
  const SPOKEN = "Twelve parcels wait at the desk until the [ledger](=ledger) clears them.";

  it("judges a counting figure by the value it settles on at the beat's end", () => {
    // Arrange
    const probed = [{ t: 2, texts: [text("div#count", "7 parcels")] }, { t: 9.95, texts: [text("div#count", "12 parcels")] }];

    // Act
    const rows = narrationRows("b1", SPOKEN, probed);

    // Assert
    expect(rows).toEqual([]);
  });

  it("names the number a settled text shows that the narration never says", () => {
    // Arrange
    const probed = [{ t: 9.95, texts: [text("div#count", "12 parcels"), text("div#more", "+ 4 late scans")] }];

    // Act
    const rows = narrationRows("b1", SPOKEN, probed);

    // Assert
    expect(rows).toEqual([{ beat: "b1", element: "div#more", rule: "unspoken-fact", text: "+ 4 late scans", atS: 9.95, fact: "4" }]);
  });

  it("flags a text sharing five narration words in a row at any moment, and passes four", () => {
    // Arrange
    const probed = [{ t: 3, texts: [text("div#echo", "parcels wait at the desk"), text("div#key", "wait at the desk")] }, { t: 9.95, texts: [] }];

    // Act
    const rows = narrationRows("b1", SPOKEN, probed);

    // Assert
    expect(rows.map((row) => [row.rule, row.element, row.atS])).toEqual([["narration-echo", "div#echo", 3]]);
  });

  it("tells the rebuild which number the narration never says", () => {
    // Arrange
    const row: LayerTextRow = { beat: "b1", element: "div#more", rule: "unspoken-fact", text: "+ 4 late scans", atS: 9.95, fact: "4" };

    // Act
    const hint = layerTextHint([row]);

    // Assert
    expect(hint).toBe("the last build broke qa's text rules: unspoken-fact on div#more \"+ 4 late scans\" (the narration never says 4: draw no number or name the narration does not say; drop it or show only what is spoken)");
  });
});
