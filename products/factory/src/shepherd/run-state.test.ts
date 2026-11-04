import { describe, expect, it } from "vitest";
import { relativeImports } from "../test-support/relative-imports.js";

describe("shepherd run-state leaf", () => {
  it("imports only the route table and CI snapshot types, so no gate step is reachable through a run record", () => {
    expect(relativeImports("shepherd/run-state.ts").sort()).toEqual(["../workflows/land-ci.js", "./route-table.js"]);
  });

  it("carry-kinds imports nothing, so a review cause reads the kinds without the merge-carry steps", () => {
    expect(relativeImports("shepherd/carry-kinds.ts")).toEqual([]);
  });

  it("the run records are declared in the leaf, not in the step modules that use them", () => {
    for (const file of ["gates", "conflict-base", "merge-order-steps", "conflict-demotion", "retarget-conflict"]) {
      expect(relativeImports(`shepherd/${file}.ts`)).toContain("./run-state.js");
    }
    expect(relativeImports("shepherd/review-cause.ts")).not.toContain("./carry-merge.js");
    expect(relativeImports("shepherd/stale-base.ts")).not.toContain("./retarget-conflict.js");
  });
});
