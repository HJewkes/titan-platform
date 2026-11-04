import { describe, expect, it } from "vitest";
import { soloScript } from "../template-fill/fill-fixtures.test-helpers.js";
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

/** The harness's one-beat script citing `factIds`, read as a run reads it: words.json and the timeline under the beat's storyboard id. */
async function citingRun(headline: string, factIds: readonly string[]) {
  const solo = soloScript({ beat: "list", labels: ["tick Two lanes"] });
  const script = { ...solo, beats: solo.beats.map((beat) => ({ ...beat, fact_ids: [...factIds] })) };
  const words = { beats: WORDS.beats.map((beat) => ({ ...beat, id: script.beats[0]!.id })) };
  const timeline = { durationS: 4, beats: [{ id: "beat-01", kind: "title", startS: 0, durationS: 4, slots: {} }] };
  const texts = [{ ...FULL_STAGE.texts[0]!, text: headline }];
  const extra = () => ({
    words: harness.store().putText(JSON.stringify(words), "words", FROM),
    script: harness.store().putText(JSON.stringify(script), "script", FROM),
  });
  return harness.run({ probeAt: () => ({ ...FULL_STAGE, texts }) }, { timeline, extra });
}

describe("qa stage narration facts", () => {
  it("passes when the narration says the headline's number in words", async () => {
    const { checks } = await headlined("40% of parcels wait");

    expect(checks["narration-facts"]).toMatchObject({ gate: true, pass: true, detail: "1 beats, every on-screen fact narrated" });
  });

  it("fails the stage on a headline number the narration never says", async () => {
    const { report, checks } = await headlined("60% of parcels wait");

    expect(checks["narration-facts"]).toMatchObject({ gate: true, pass: false, detail: '1 unspoken: [b1] number "60%"' });
    expect(failedGates(Object.values(checks)).map((check) => check.name)).toEqual(["narration-facts"]);
    expect(report.narrationFacts?.findings).toEqual([{ beat: "b1", kind: "number", fact: "60%", shown: "60% of parcels wait" }]);
  });

  it("passes a headline that shows the number of a pull request the beat cites, left unspoken", async () => {
    const { checks } = await citingRun("Card 6420 holds 40% of parcels", ["pr/acme/depot#6420/merged"]);

    expect(checks["narration-facts"]).toMatchObject({ gate: true, pass: true, detail: "1 beats, every on-screen fact narrated" });
  });
});
