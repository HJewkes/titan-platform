import { describe, expect, it } from "vitest";
import { proceedsOnNoRepro } from "./no-repro-test-only.js";
import { CHANGESET, SPEC, TEST, gate, scene, vacuousLine } from "./no-repro-test-only.test-helpers.js";

describe("proceedsOnNoRepro on a diff of tests and a changeset", () => {
  it("lets a correctness registration proceed, since its diff makes it test-only for proof", async () => {
    expect(await proceedsOnNoRepro(scene([TEST, CHANGESET]), gate("correctness"), vacuousLine())).toBe(true);
  });

  it("keeps a security registration gated", async () => {
    expect(await proceedsOnNoRepro(scene([TEST, CHANGESET]), gate("security"), vacuousLine())).toBe(false);
  });

  it("keeps a correctness registration gated once the diff also changes source", async () => {
    const files = [TEST, CHANGESET, { path: "packages/x/src/view.ts", status: "modified" } as const];

    expect(await proceedsOnNoRepro(scene(files), gate("correctness"), vacuousLine())).toBe(false);
  });

  it("keeps a correctness registration gated when its mutation spec is refused", async () => {
    const refused = vacuousLine({ verdict: "error", results: [], error: "mutants: spec refused" });

    expect(await proceedsOnNoRepro(scene([TEST, SPEC, CHANGESET]), gate("correctness"), refused)).toBe(false);
  });
});
