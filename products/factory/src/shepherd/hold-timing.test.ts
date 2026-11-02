import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

describe("shepherd hold-timing leaf", () => {
  it("imports nothing relative, so the train and merge-order never reach hold.ts through it", () => {
    expect(relativeImports("shepherd/hold-timing.ts")).toEqual([]);
  });

  it.each(["train.ts", "merge-order-steps.ts", "advisory.ts", "g10-release.ts"])("%s reads the hold timing from the leaf, not hold.ts", (file) => {
    expect(relativeImports(`shepherd/${file}`)).not.toContain("./hold.js");
  });
});
