import { describe, expect, it } from "vitest";
import { importGraph } from "./test-support/import-graph.js";
import { cycles } from "./test-support/scc.js";

/** The largest import cycle in factory source; lower it when a slice cuts one, never raise it to make a feature fit. */
const CEILING = 139;

describe("factory import cycles", () => {
  it("keeps the largest import cycle, counting type edges, within the ceiling", () => {
    const sizes = cycles(importGraph({ valueOnly: false })).map((cycle) => cycle.length);

    expect(sizes[0] ?? 0).toBeLessThanOrEqual(CEILING);
  });
});
