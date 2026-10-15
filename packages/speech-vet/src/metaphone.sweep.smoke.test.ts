import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { metaphone } from "./metaphone.js";

// Opt-in: set SPEECH_VET_METAPHONE_SWEEP to the out-of-repo sweep file (every dictionary headword with
// its jellyfish code). It skips in CI, where that file does not exist.
const sweepPath = process.env.SPEECH_VET_METAPHONE_SWEEP;
const run = sweepPath && existsSync(sweepPath) ? describe : describe.skip;

run("metaphone full sweep against jellyfish 1.2.1 (Rust)", () => {
  it("matches every word", () => {
    const { cases } = JSON.parse(readFileSync(sweepPath!, "utf8")) as { cases: { word: string; code: string }[] };
    const differences = cases.filter(({ word, code }) => metaphone(word) !== code);
    console.log(`metaphone sweep: ${cases.length - differences.length} of ${cases.length} match`);
    expect(differences).toHaveLength(0);
  });
});
