import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { metaphone } from "./metaphone.js";

const Sweep = z.object({ cases: z.array(z.object({ word: z.string(), code: z.string() })) });

// Opt-in: set SPEECH_VET_METAPHONE_SWEEP to the out-of-repo sweep file (every dictionary headword with
// its jellyfish code). It skips in CI, where that file does not exist.
const sweepPath = process.env.SPEECH_VET_METAPHONE_SWEEP;
const run = sweepPath && existsSync(sweepPath) ? describe : describe.skip;

run("metaphone full sweep against jellyfish 1.2.1 (Rust)", () => {
  it("matches every word", () => {
    const { cases } = Sweep.parse(JSON.parse(readFileSync(sweepPath!, "utf8")));
    const differences = cases.filter(({ word, code }) => metaphone(word) !== code);
    console.log(`metaphone sweep: ${cases.length - differences.length} of ${cases.length} match`);
    expect(differences).toHaveLength(0);
  });
});
