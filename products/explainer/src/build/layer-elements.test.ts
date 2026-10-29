import { describe, expect, it } from "vitest";
import { exposedElements, missingCueElements } from "./layer-elements.js";

// Synthetic: an invented parcel-desk layer; no real build.
const MODULE = `export default () => (<div><div id="desk" /><div id={'ledger'} /></div>);\n`;

describe("the cue targets a built custom layer exposes", () => {
  it("exposes each declared element its source spells as an id literal", () => {
    // Arrange
    const layer = { module: MODULE, elements: ["desk", "ledger"] };

    // Act
    const exposed = exposedElements(layer);

    // Assert
    expect(exposed).toEqual(["desk", "ledger"]);
  });

  it("names a declared target the source never spells, and an undeclared one it does, once each in cue order", () => {
    // Arrange
    const layer = { module: MODULE, elements: ["desk", "scanner"] };

    // Act
    const missing = missingCueElements(["scanner", "ledger", "desk", "scanner"], layer);

    // Assert
    expect(missing).toEqual(["scanner", "ledger"]);
  });
});
