import { describe, expect, it } from "vitest";
import { L0_CHECKS, l0HardPass, runL0 } from "./eval-l0.js";
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

// The fixture voices no simplifications, so every script held to Q-F12 fails it.
const limitsRowsFor = (profile: string, structure: string) =>
  runL0(ScriptSchema.parse({ ...scriptWith(), profile, structure }), undefined, L0_CHECKS).filter((r) => r.check_id === "Q-F12");

describe("Q-F12 voiced limits, exempt for the daily briefing only", () => {
  // Mutation: dropping the except_profiles filter emits a failing Q-F12 row here.
  it("emits no voiced-limits row for a daily-overview script", () => {
    expect(limitsRowsFor("daily-overview", "scqa")).toEqual([]);
  });

  it.each(["paper-summary", "pr-overview", "repo-argument"])("still holds a %s script that picks scqa to voiced limits", (profile) => {
    const rows = limitsRowsFor(profile, "scqa");

    expect(rows.map((r) => r.pass)).toEqual([false]);
  });

  it("still holds a repo-tour design-journey script to voiced limits", () => {
    const rows = limitsRowsFor("repo-tour", "design-journey");

    expect(rows.map((r) => r.pass)).toEqual([false]);
  });
});

describe("script-only variety lints at L0", () => {
  it("reports a stock hook as a warning row that never fails the script", () => {
    const script = ScriptSchema.parse(scriptWith({ spoken: "So what can parcel-desk crib from the ledger service?" }));

    const rows = runL0(script, undefined, L0_CHECKS).filter((r) => r.check_id.startsWith("variety:"));

    expect(rows.map((r) => r.check_id)).toEqual(["variety:hook-formula", "variety:connector-share", "variety:cue-action"]);
    expect(rows.find((r) => r.check_id === "variety:hook-formula")).toMatchObject({ severity: "warning", pass: false, detail_beats: ["c2-1-stations"] });
    expect(rows.every((r) => r.severity === "warning")).toBe(true);
    expect(l0HardPass(rows)).toBe(true);
  });
});
