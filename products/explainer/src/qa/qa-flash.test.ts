import { describe, expect, it } from "vitest";
import { failedGates } from "../workflow/stage-checks.js";
import { qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();

const CLEAN = { maxPerS: 0, windows: [] };
const FLASHING = { maxPerS: 5, windows: [{ startS: 0.5, endS: 2 }] };

describe("qa stage photosensitive flash", () => {
  it("records the flash scan in qa.json", async () => {
    const flash = { method: "synthetic", general: FLASHING, red: CLEAN };

    const { report } = await harness.run({ flash });

    expect(report.flash).toEqual(flash);
  });

  it.each([
    ["general", { general: FLASHING, red: CLEAN }, "general 5/s over 3 at 0.50-2.00 s; red 0/s (synthetic)"],
    ["red", { general: CLEAN, red: FLASHING }, "general 0/s; red 5/s over 3 at 0.50-2.00 s (synthetic)"],
  ])("reports a %s flash above three a second, and never fails the stage", async (_kind, kinds, detail) => {
    const { report, checks } = await harness.run({ flash: { method: "synthetic", ...kinds } });

    expect(checks["photosensitive-flash"]).toEqual({ name: "photosensitive-flash", gate: false, pass: false, detail });
    expect(failedGates(Object.values(checks))).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("passes a scan that found three or fewer flashes in every second", async () => {
    const { checks } = await harness.run({ flash: { method: "synthetic", general: { maxPerS: 3, windows: [] }, red: CLEAN } });

    expect(checks["photosensitive-flash"]?.pass).toBe(true);
  });
});
