import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { REGISTER_BANDS, registerCheck, spokenText } from "./lint-register.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS } from "./lint-voice.js";
import { planRegisterEdits } from "./rewrite-plan.js";
import type { ScriptV1 } from "./script-schema.js";
import { tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

// Short, number-free, list-free sentences about an invented parcel desk: the raw stuff of a choppy script.
const CHOPPY = [
  "The desk reads each scan first.",
  "It asks the ledger for a row.",
  "The row says where the parcel is.",
  "A missing row stops the label.",
  "The courier sees that refusal at once.",
  "Nothing prints before the ledger answers.",
];

// The tour's thesis_refs name h1, w4 and c1, so the first three beats carry those ids.
const ids = (n: number): string[] => ["h1", "w4", "c1", ...Array.from({ length: n - 3 }, (_, i) => `b${i}`)];
const script = (lines: readonly string[]): ScriptV1 =>
  tour(lines.map((spoken, i): BeatSpec => [ids(lines.length)[i]!, `ch${1 + (i % 4)}`, "WHAT", spoken]));

const choppyLines = (beats: number): string[] =>
  Array.from({ length: beats }, (_, i) => Array.from({ length: 2 + (i % 4) }, (_, j) => CHOPPY[(i + j) % CHOPPY.length]).join(" "));

const planAt = (s: ScriptV1, cap: number) => planRegisterEdits(s, runL0(s, undefined, [registerCheck]), { cap });
const longestPlanned = (s: ScriptV1, cap: number): number => Math.max(...planAt(s, cap).directives.flatMap((d) => d.shape ?? []));

describe("planRegisterEdits: longest planned sentence", () => {
  it.each([6, 9, 12, 18, 24, 36])("stays at 24 words under the vetted cap on a %i-beat script", (beats) => {
    const wordy = script(choppyLines(beats));

    const longest = longestPlanned(wordy, MAX_VETTED_SENTENCE_WORDS);

    expect(longest).toBeLessThanOrEqual(24);
  });

  it.each([9, 12, 24, 36])("plans every word of each beat of a %i-beat script under the vetted cap", (beats) => {
    const wordy = script(choppyLines(beats));

    const { directives } = planAt(wordy, MAX_VETTED_SENTENCE_WORDS);

    for (const directive of directives.filter((d) => d.shape)) {
      const beat = wordy.beats.find((b) => b.id === directive.beat)!;
      expect(directive.shape!.reduce((sum, n) => sum + n, 0)).toBe(spokenText([beat.spoken]).words.length);
    }
  });

  // One-sentence beats hold their count, so the wordy beats get too few sentences and overflow the most.
  it.each([26, 28, 30, 32, 34, 36, 38, 40, 44, 48])("stays at 24 words when wordy beats speak %i sentences each", (sentences) => {
    const speech = Array.from({ length: sentences }, (_, i) => CHOPPY[i % CHOPPY.length]).join(" ");
    const wordy = script([...Array<string>(20).fill(CHOPPY[0]!), speech, speech]);

    const longest = longestPlanned(wordy, MAX_VETTED_SENTENCE_WORDS);

    expect(longest).toBeLessThanOrEqual(24);
  });

  it("holds the sentence count on a beat over the limit, so the planned mean stays over its floor", () => {
    const { projected } = planAt(script(choppyLines(24)), MAX_VETTED_SENTENCE_WORDS);

    expect(projected!.mean).toBeGreaterThanOrEqual(REGISTER_BANDS["sentence-mean"].min!);
  });

  it("keeps the headroom under the plain cap, as without --speech-vet", () => {
    const longest = longestPlanned(script(choppyLines(24)), MAX_SENTENCE_WORDS);

    expect(longest).toBeLessThanOrEqual(MAX_SENTENCE_WORDS - 4);
  });
});
