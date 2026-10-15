import { describe, expect, it } from "vitest";
import replay from "./fixtures/phones-replay.golden.json" with { type: "json" };
import { chunkWordVerdicts, detectHallucinations, detectTailArtifact, type WordVerdict } from "./phone-verdicts.js";
import { replayCaseG2p } from "./recorded-g2p.test-helpers.js";

// The fixture holds AB's own output, so its keys are Python's.
const asRecorded = ({ word, expectedPhones, actualPhones, distance, source }: WordVerdict) => ({
  word,
  expected_phones: expectedPhones,
  actual_phones: actualPhones,
  distance,
  source,
});

// Mutation caught: indexMap's mapping[i] = j1 + ... + 1, which shifts the actual spans of most cases.
describe("RF golden replay against AB's recorded verdicts", () => {
  const voice = replay._source.voice;

  it.each(replay.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const g2p = replayCaseG2p(c.espeak, voice);
    const words = chunkWordVerdicts(c.text, c.raw, { g2p, voice, targets: c.targets, unusual: c.unusual });

    expect(words.map(asRecorded)).toEqual(c.expected.words);
    expect(detectHallucinations(c.text, c.raw, { g2p, voice })).toEqual(c.expected.halluc);
    expect(detectTailArtifact(c.text, c.raw, { g2p, voice })).toEqual(c.expected.tail);
    if ("plain" in c) {
      const plain = chunkWordVerdicts(c.text, c.raw, { g2p, voice, targets: c.targets });
      expect(plain.map(asRecorded)).toEqual(c.plain);
    }
  });
});
