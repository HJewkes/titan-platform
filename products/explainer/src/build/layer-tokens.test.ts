import { describe, expect, it } from "vitest";
import { themeColorTokens, tokenHint, undefinedTokenFindings } from "./layer-tokens.js";

// Synthetic: hand-written layer lines for an invented parcel desk.
const DEFINED = new Set(["color-border-prominent", "color-text-primary"]);

describe("the colour token check on a layer's source", () => {
  it("names the line and token of a fill the theme does not define", () => {
    // Arrange
    const module = [
      "export default () => <div>",
      "  <div id=\"bar\" style={{ background: \"var(--color-border-subtle)\" }} />",
      "  <span style={{ color: \"var(--color-text-primary)\" }}>12</span>",
      "</div>;",
    ].join("\n");

    // Act
    const findings = undefinedTokenFindings(module, DEFINED);

    // Assert
    expect(findings).toEqual([{ line: 2, token: "color-border-subtle" }]);
  });

  it("passes a token the layer sets itself before it reads it", () => {
    // Arrange
    const module = "export default () => <div style={{ \"--color-lane\": \"#1e6fd9\", background: \"var(--color-lane)\" } as never} />;";

    // Act
    const findings = undefinedTokenFindings(module, DEFINED);

    // Assert
    expect(findings).toEqual([]);
  });

  it("reads the theme's tokens from the react-ui package the page loads", () => {
    // Arrange
    const tokens = themeColorTokens();

    // Act
    const hinted = [...tokenHint([{ line: 2, token: "color-border-subtle" }]).matchAll(/var\(--(color-[a-z-]+)\)/g)].map((m) => m[1]!);

    // Assert
    expect(tokens.has("color-border-subtle")).toBe(false);
    expect(hinted.length).toBeGreaterThan(0);
    expect(hinted.filter((token) => !tokens.has(token))).toEqual([]);
  });
});
