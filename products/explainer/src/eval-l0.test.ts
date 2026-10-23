import { describe, expect, it } from "vitest";
import { L0_CHECKS, runL0 } from "./eval-l0.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const SCOPED = ["Q-W8", "Q-F3", "Q-F4", "Q-F5"];

// A script with no FENCE beat, running example, thesis triple or pivot: it fails every scoped rule it is held to.
const rowsFor = (structure?: string) =>
  runL0(ScriptSchema.parse({ ...scriptWith(), ...(structure ? { structure } : {}) }), undefined, L0_CHECKS).filter((r) => SCOPED.includes(r.check_id));

describe("L0 rules scoped by structure", () => {
  // Mutation: dropping the structure filter in runL0 emits the four rows under scqa and fails the first assertion.
  it("emits no FENCE, running-example, thesis or pivot row for an scqa script", () => {
    expect(rowsFor("scqa")).toEqual([]);
  });

  it("still holds a design-journey script to those rules", () => {
    const rows = rowsFor("design-journey");

    expect(rows.map((r) => r.check_id).sort()).toEqual([...SCOPED].sort());
    expect(rows.every((r) => !r.pass)).toBe(true);
  });

  it("still holds a structureless legacy script to those rules", () => {
    expect(rowsFor().map((r) => r.check_id).sort()).toEqual([...SCOPED].sort());
  });
});
