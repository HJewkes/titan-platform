import { describe, expect, it } from "vitest";
import { CONTEXT_BANDS, GAP_BANDS, bandOf, contextBand, gapBand } from "./bands.js";

describe("contextBand", () => {
  it("puts each boundary in the upper band", () => {
    expect(contextBand(0)).toBe("<50k");
    expect(contextBand(49_999)).toBe("<50k");
    expect(contextBand(50_000)).toBe("50-100k");
    expect(contextBand(100_000)).toBe("100-200k");
    expect(contextBand(200_000)).toBe("200k+");
    expect(contextBand(5_000_000)).toBe("200k+");
  });
});

describe("gapBand", () => {
  it("bands an idle gap in milliseconds", () => {
    expect(gapBand(0)).toBe("<5m");
    expect(gapBand(5 * 60_000 - 1)).toBe("<5m");
    expect(gapBand(5 * 60_000)).toBe("5-60m");
    expect(gapBand(60 * 60_000)).toBe(">60m");
  });
});

describe("bandOf", () => {
  it("returns null below every band rather than inventing one", () => {
    expect(bandOf(-1, CONTEXT_BANDS)).toBeNull();
    expect(bandOf(-1, GAP_BANDS)).toBeNull();
  });
});
