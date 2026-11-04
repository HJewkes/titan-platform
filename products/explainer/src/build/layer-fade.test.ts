import { describe, expect, it } from "vitest";
import { fadedTextFindings, fadeHint } from "./layer-fade.js";

// Synthetic: invented layer sources for a parcel desk.
const layer = (...lines: string[]) => `export default function Desk() {\n  return (\n${lines.join("\n")}\n  );\n}\n`;

describe("fadedTextFindings", () => {
  it("flags a text badge whose opacity ramps, naming its line and text", () => {
    // Arrange
    const source = layer(`    <div id="desk"><span style={{ ...badge, opacity: ramp(t, at + 0.8) }}>held</span></div>`);

    // Act
    const findings = fadedTextFindings(source);

    // Assert
    expect(findings).toEqual([{ line: 3, element: "span", text: "held" }]);
  });

  it("flags a container whose opacity fades the text inside it", () => {
    // Arrange
    const source = layer(`    <div id="row" style={{ opacity: row }}>`, `      <b>12</b> parcels`, `    </div>`);

    // Act
    const findings = fadedTextFindings(source);

    // Assert
    expect(findings).toEqual([expect.objectContaining({ element: "row", text: "12" })]);
  });

  it("flags text drawn by an element that calls a helper holding the opacity", () => {
    // Arrange
    const source = `const card = (p: number) => ({ flex: 1, opacity: p });\n` + layer(`    <div id="card-1" style={card(k1)}>Held</div>`);

    // Act
    const findings = fadedTextFindings(source);

    // Assert
    expect(findings).toEqual([expect.objectContaining({ element: "card-1", text: "Held" })]);
  });

  it("does not flag a fading shape that renders no text", () => {
    // Arrange
    const source = layer(`    <div id="bar" style={{ opacity: ramp(t, at), background: "var(--color-brand-primary-solid)" }} />`, `    <span>held</span>`);

    // Act
    const findings = fadedTextFindings(source);

    // Assert
    expect(findings).toEqual([]);
  });

  it("does not flag text that enters by translate and scale at opacity 1", () => {
    // Arrange
    const source = layer(`    <span style={{ opacity: 1, transform: \`translateY(\${(1 - p) * 30}px) scale(\${p})\` }}>held</span>`);

    // Act
    const findings = fadedTextFindings(source);

    // Assert
    expect(findings).toEqual([]);
  });

  it("flags text set below full opacity", () => {
    // Arrange
    const source = layer(`    <span style={{ opacity: 0.5 }}>{label}</span>`);

    // Act
    const findings = fadedTextFindings(source);

    // Assert
    expect(findings).toEqual([expect.objectContaining({ element: "span", text: "{label}" })]);
  });
});

describe("fadeHint", () => {
  it("names the layer, the element and its text, and the full-colour entrance", () => {
    // Arrange
    const findings = [{ line: 3, element: "badge-1", text: "held" }];

    // Act
    const hint = fadeHint("b1", findings);

    // Assert
    expect(hint).toBe('b1 badge-1 "held": enter text at full colour, by translate, scale or clip-path, never an opacity fade');
  });
});
