import { describe, expect, it } from "vitest";
import { fontFindings, fontHint } from "./layer-fonts.js";

// Synthetic: invented layer sources for a parcel desk.
const layer = (...lines: string[]) => `export default function Desk() {\n${lines.join("\n")}\n}\n`;

describe("fontFindings", () => {
  it.each([
    ["an @font-face rule", layer(`  const css = "@font-face { src: local(Desk); }";`), "@font-face"],
    ["a font file import", layer(`  import face from "./desk.woff2";`), "font import"],
    ["a url() to a font file", layer(`  const s = { src: "url(/assets/desk.ttf)" };`), "font url"],
    ["a remote font host", layer(`  const s = "https://fonts.googleapis.com/css?family=Inter";`), "remote font host"],
    ["a font family outside the theme tokens", layer(`  return <div style={{ fontFamily: "Inter, sans-serif" }} />;`), "font family"],
    ["a CSS font-family outside the theme tokens", layer(`  const s = "font-family: 'Desk Sans'";`), "font family"],
  ])("flags %s, naming its line", (_name, source, rule) => {
    // Act
    const findings = fontFindings(source);

    // Assert
    expect(findings).toEqual([expect.objectContaining({ line: 2, rule })]);
  });

  it("passes a layer that styles text with the theme font tokens", () => {
    // Arrange
    const source = layer(
      `  const a = { fontFamily: "var(--font-family-heading)" };`,
      `  const b = { fontFamily: "var(--font-family-mono, monospace)", fontSize: 48 };`,
      `  return <div style={{ fontFamily: "inherit" }} />;`,
    );

    // Act
    const findings = fontFindings(source);

    // Assert
    expect(findings).toEqual([]);
  });

  it("tells a rebuild each line and to use the theme font tokens", () => {
    // Arrange
    const findings = fontFindings(layer(`  return <div style={{ fontFamily: "Inter" }} />;`));

    // Act
    const hint = fontHint(findings);

    // Assert
    expect(hint).toMatch(/^the last build set its own fonts: line 2 \(font family\)/);
    expect(hint).toContain("--font-family-body");
  });
});
