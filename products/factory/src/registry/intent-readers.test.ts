import { describe, expect, it } from "vitest";
import { isFactEntry } from "./entry.js";
import { INTENT_READERS } from "./intent-readers.js";
import { factoryRegistry } from "./steps/index.js";

describe("intent readers", () => {
  it("every irreversible fact entry has an intent reader", () => {
    const irreversible = factoryRegistry.entries.filter((entry) => isFactEntry(entry) && entry.effect.class === "irreversible").map((entry) => entry.name);

    const uncovered = irreversible.filter((step) => INTENT_READERS[step] === undefined);

    expect(irreversible).toContain("merge");
    expect(uncovered).toEqual([]);
  });
});
