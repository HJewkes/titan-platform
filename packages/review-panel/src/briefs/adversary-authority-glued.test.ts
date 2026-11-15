import { describe, expect, it } from "vitest";
import { authorityLine } from "./adversary.js";

describe("authorityLine with a glued Authority label", () => {
  it("a hyphen-glued widened label reads widened", () => {
    expect(authorityLine("Authority-gate: widened")).toBe("widened");
  });

  it("an underscore-glued widened label reads widened", () => {
    expect(authorityLine("Authority_level: widened")).toBe("widened");
  });

  it("a glued label next to Authority: unchanged reads malformed, never unchanged", () => {
    expect(authorityLine("Authority-widens: bot merges\nAuthority: unchanged")).toBe("malformed");
    expect(authorityLine("Authority: unchanged\nAuthority-gate: widened")).toBe("widened");
  });

  it("a code-name lead reads malformed", () => {
    expect(authorityLine("authorityLevel is checked first\nAuthority: unchanged")).toBe("malformed");
  });
});
