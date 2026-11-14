import { describe, expect, it } from "vitest";
import { FILLER, NAMING, tourOf } from "./hallmark-fixtures.test-helpers.js";
import { repairHint } from "./l0-repair-hints.js";
import { hallmarkCheck } from "./lint-hallmarks.js";
import { lint, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

describe("the naming-refrain repair hint", () => {
  it("quotes the naming lines with their beats and none of the filler", () => {
    const [first = "", ...rest] = NAMING;
    const specs: BeatSpec[] = [...FILLER, `${first} Steam rushes through it once the water boils.`, ...rest].map((line, i) => [`b${i + 1}`, "ch1", "WHAT", line]);
    const script = tourOf(specs);
    const row = lint(script, [hallmarkCheck]).get("hallmark:naming-refrain")!;

    const hint = repairHint(row, script) ?? "";

    expect(hint).toContain('b11 "That little whistle is called the vent note."');
    expect(hint).toContain("b13");
    expect(hint).not.toContain("garden");
    expect(hint).not.toContain("Steam rushes");
  });
});
