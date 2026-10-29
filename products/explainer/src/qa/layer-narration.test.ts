import { describe, expect, it } from "vitest";
import { narrationRows } from "./layer-narration.js";

// Synthetic: an invented parcel desk.
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
});
