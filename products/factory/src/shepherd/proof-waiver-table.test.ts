import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

describe("shepherd proof-waiver-table leaf", () => {
  it("imports nothing relative, so the store never reaches the land workflow through it", () => {
    expect(relativeImports("shepherd/proof-waiver-table.ts")).toEqual([]);
  });

  it("store.ts reads the waiver table from the leaf, not proof-waiver.ts", () => {
    expect(relativeImports("shepherd/store.ts")).toContain("./proof-waiver-table.js");
    expect(relativeImports("shepherd/store.ts")).not.toContain("./proof-waiver.js");
  });
});
