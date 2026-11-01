import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

describe("seat-reader leaf", () => {
  it("imports no relative module, so reviewer-reader and external-review share it without a cycle", () => {
    expect(relativeImports("shepherd/seat-reader.ts")).toEqual([]);
  });

  it("external-review no longer re-exports DamagedTranscriptError", () => {
    expect(relativeImports("shepherd/external-review.ts")).toContain("./seat-evidence.js");
    expect(relativeImports("shepherd/reviewer-reader.ts")).not.toContain("./external-review.js");
  });
});
