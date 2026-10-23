import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSpeechBands } from "./speech-bands.js";

describe("speech bands", () => {
  it("ships the C5 rates and density caps adopted in decision 317a", () => {
    expect(loadSpeechBands()).toEqual({
      story: { wpm: 195, wordsPerS: 3.2 },
      concept: { wpm: 175, wordsPerS: 2.8 },
      code: { wpm: 160, wordsPerS: 2.3 },
      takeaways: { wpm: 180, wordsPerS: 2.8 },
      held: { wpm: 175, wordsPerS: 1.5 },
    });
  });

  it("refuses a table that leaves a speech band out", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "explainer-bands-"));
    writeFileSync(path.join(dir, "speech-bands.yaml"), "schema: speech-bands/v1\nbands:\n  story: { wpm: 195, wordsPerS: 3.2 }\n");

    try {
      expect(() => loadSpeechBands(dir)).toThrow(/concept/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
