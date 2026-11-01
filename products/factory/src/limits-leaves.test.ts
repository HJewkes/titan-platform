import { describe, expect, it } from "vitest";
import { relativeImports } from "./test-support/relative-imports.js";

describe("limit leaves", () => {
  it("note-limits.ts imports nothing in factory", () => {
    expect(relativeImports("note-limits.ts")).toEqual([]);
  });

  it("spawn-limits.ts imports nothing in factory, so machine-stop and spawn-gate no longer close a value cycle", () => {
    expect(relativeImports("shepherd/spawn-limits.ts")).toEqual([]);
  });
});
