import { describe, expect, it } from "vitest";
import { styleTellNote, styleTells } from "./layer-style-tells.js";

// Synthetic: an invented parcel desk layer; no real script or layer.
const layer = (style: string) => `export default () => <div id="parcels" style={{ ${style} }}>12 parcels held</div>;\n`;

describe("style tells in a custom layer's source", () => {
  it("counts two gradient layers and reports them", () => {
    // Arrange
    const source = layer('background: "linear-gradient(red, blue), radial-gradient(circle, white, black)"');

    // Act
    const tells = styleTells(source);

    // Assert
    expect(tells).toEqual({ gradients: 2, glows: 0 });
    expect(styleTellNote("b1", tells)).toBe("b1 uses 2 gradients: decorative styling, kept as built");
  });

  it("counts a conic gradient too", () => {
    expect(styleTells(layer('background: "conic-gradient(red, blue)"')).gradients).toBe(1);
  });

  it("reports a zero-offset blurred box-shadow as a glow", () => {
    // Arrange
    const source = layer('boxShadow: "0 0 24px rgba(255, 200, 0, 0.8)"');

    // Act
    const tells = styleTells(source);

    // Assert
    expect(tells).toEqual({ gradients: 0, glows: 1 });
    expect(styleTellNote("b1", tells)).toBe("b1 uses 1 glow effect: decorative styling, kept as built");
  });

  it("reports a blurred text-shadow, a drop-shadow filter and a blur filter as glows", () => {
    expect(styleTells(layer('textShadow: "0px 0px 8px #fff"')).glows).toBe(1);
    expect(styleTells(layer('filter: "drop-shadow(0 0 6px gold)"')).glows).toBe(1);
    expect(styleTells(layer('filter: "blur(4px)"')).glows).toBe(1);
  });

  it("does not report an offset hard shadow or a single gradient", () => {
    // Arrange
    const source = layer('boxShadow: "4px 4px 0 #000", background: "linear-gradient(red, blue)"');

    // Act
    const tells = styleTells(source);

    // Assert
    expect(tells).toEqual({ gradients: 1, glows: 0 });
    expect(styleTellNote("b1", tells)).toBeUndefined();
  });

  it("counts a style passed as a template string", () => {
    // Arrange
    const source = "const css = `\n  .card { background: linear-gradient(red, blue), conic-gradient(red, blue); box-shadow: 0 0 12px red; }\n`;\n";

    // Act
    const tells = styleTells(source);

    // Assert
    expect(tells).toEqual({ gradients: 2, glows: 1 });
  });
});
