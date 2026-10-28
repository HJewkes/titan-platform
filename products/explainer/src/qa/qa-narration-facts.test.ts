import { describe, expect, it } from "vitest";
import { failedGates } from "../workflow/stage-checks.js";
import { FULL_STAGE } from "./qa-fakes.test-helpers.js";
import { FROM, qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();

const SPOKEN = "forty percent of parcels wait at the desk";
const WORDS = { beats: [{ id: "b1", startS: 0, durationS: 4, words: SPOKEN.split(" ").map((word, i) => ({ word, start: 0.5 + i * 0.3, end: 0.7 + i * 0.3 })) }] };

async function headlined(headline: string) {
  const texts = [{ ...FULL_STAGE.texts[0]!, text: headline }];
  const extra = () => ({ words: harness.store().putText(JSON.stringify(WORDS), "words", FROM) });
  return harness.run({ probeAt: () => ({ ...FULL_STAGE, texts }) }, { extra });
}

describe("qa stage narration facts", () => {
  it("passes when the narration says the headline's number in words", async () => {
    const { checks } = await headlined("40% of parcels wait");

    expect(checks["narration-facts"]).toMatchObject({ gate: false, pass: true, detail: "1 beats, every on-screen fact narrated" });
  });

  it("reports a headline number the narration never says, and never fails the stage", async () => {
    const { report, checks } = await headlined("60% of parcels wait");

    expect(checks["narration-facts"]).toMatchObject({ gate: false, pass: false, detail: '1 unspoken: [b1] number "60%"' });
    expect(failedGates(Object.values(checks))).toEqual([]);
    expect(report.narrationFacts?.findings).toEqual([{ beat: "b1", kind: "number", fact: "60%", shown: "60% of parcels wait" }]);
  });
});
