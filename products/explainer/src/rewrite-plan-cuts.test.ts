import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { FILLER, NAMING, tourOf } from "./hallmark-fixtures.test-helpers.js";
import { hallmarkCheck } from "./lint-hallmarks.js";
import { planRegisterEdits } from "./rewrite-plan.js";
import type { BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

const specsOf = (lines: readonly string[]): BeatSpec[] => lines.map((spoken, i) => [`b${i + 1}`, `ch${1 + (i % 4)}`, "WHAT", spoken]);
const cutsFor = (lines: readonly string[], beat: string): string[] | undefined => {
  const script = tourOf(specsOf(lines));
  const plan = planRegisterEdits(script, runL0(script, undefined, [hallmarkCheck]));
  return plan.directives.find((directive) => directive.beat === beat)?.cuts;
};

describe("planRegisterEdits: hallmark cuts", () => {
  it("lists the naming sentences of a beat while the naming-refrain row fails", () => {
    expect(cutsFor([...FILLER, ...NAMING], "b11")).toEqual([NAMING[0]]);
    expect(cutsFor([...FILLER, ...NAMING], "b13")).toEqual([NAMING[2]]);
  });

  it("gives no cuts once the naming-refrain row passes", () => {
    expect(cutsFor([...FILLER, NAMING[0]!], "b11")).toBeUndefined();
  });

  it("still lists a teaser sentence that carries a cue word", () => {
    const teaser = "By the end of this, you'll be able to fix any kettle.";
    const lines = [...FILLER, teaser];
    const script = tourOf(specsOf(lines).map((spec, i): BeatSpec => (i === 10 ? [spec[0], spec[1], spec[2], spec[3], { visual: { assertion: "A kettle", job: "numbers", cues: [{ action: "V6", target: "kettle-card", atCue: "kettle" }] } }] : spec)));
    const plan = planRegisterEdits(script, runL0(script, undefined, [hallmarkCheck]));

    expect(plan.directives.find((directive) => directive.beat === "b11")?.cuts).toEqual([teaser]);
  });
});
