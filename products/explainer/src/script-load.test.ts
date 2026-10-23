import { describe, expect, it } from "vitest";
import { UnknownStructureError } from "./profile-load.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { parseScript } from "./script-load.js";

describe("parseScript", () => {
  it("accepts a structure the registry holds", () => {
    expect(parseScript({ ...scriptWith(), structure: "bluf" }).structure).toBe("bluf");
  });

  // Mutation: skipping the registry lookup lets an unknown structure through.
  it("rejects a structure the registry lacks, naming the known ones", () => {
    expect(() => parseScript({ ...scriptWith(), structure: "hero-quest" })).toThrow(UnknownStructureError);
    expect(() => parseScript({ ...scriptWith(), structure: "hero-quest" })).toThrow(/known: .*design-journey/);
  });

  it("accepts a legacy script that names no structure, whatever the registry holds", () => {
    expect(parseScript(scriptWith(), new Map()).structure).toBeUndefined();
  });
});
