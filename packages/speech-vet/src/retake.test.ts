import type { Audio } from "@titan-design/speech-stt";
import { describe, expect, it } from "vitest";
import type { PhoneRecognizer } from "./phone-verdicts.js";
import type { PhoneG2p } from "./phones.js";
import {
  bestTailTake,
  keepTake,
  regressions,
  synthesizeVerified,
  WORSE_MARGIN,
  type TailCandidate,
  type WordDistance,
} from "./retake.js";

// A synthetic sentence and a one-letter-per-phone dictionary, so a take's phones are built by hand.
const TEXT = "we need to get him here";
const LEXICON: Readonly<Record<string, string>> = {
  we: "wi",
  need: "nid",
  to: "tu",
  get: "gɛt",
  him: "hɪm",
  here: "hɪɹ",
};
const g2p: PhoneG2p = (text) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => LEXICON[w] ?? w)
    .join(" ");
const CLEAN = Object.values(LEXICON).join("");
const STRAY = "tʃə";
const AUDIO: Audio = { samples: new Float32Array(0), sampleRate: 16_000 };

const dist = (distance: number, faulty: boolean): WordDistance => ({ distance, faulty });
const wordMap = (entries: Record<string, WordDistance>) => new Map(Object.entries(entries));

// The audiobook backend's test_fix_tails.py cases, under their pytest names.
describe("AB tail-fix cases: best take", () => {
  const candidates = (...phones: string[]): TailCandidate<string>[] =>
    phones.map((p, i) => ({ label: `t${i}`, take: async () => ({ value: `wav${i}`, phones: p }) }));
  const run = (shippedPhones: string, ...takes: string[]) =>
    bestTailTake({ text: TEXT, shippedPhones, before: { length: 3 }, candidates: candidates(...takes), g2p });

  // Mutation caught: kept requires the stray to be gone, not just shorter.
  it("test_take_that_clears_the_stray_is_kept", async () => {
    const r = await run(CLEAN + STRAY, CLEAN, CLEAN, CLEAN);
    expect(r.kept).toBe(true);
    expect(r.afterLength).toBe(0);
  });

  it("test_take_that_only_shortens_the_stray_is_still_kept", async () => {
    const r = await run(CLEAN + STRAY, CLEAN + "t");
    expect(r.kept).toBe(true);
    expect(r.afterLength).toBe(1);
  });

  // Mutation caught: a take of equal stray length ships.
  it("test_no_improvement_is_discarded", async () => {
    const r = await run(CLEAN + STRAY, CLEAN + STRAY);
    expect(r.kept).toBe(false);
  });

  // Mutation caught: the broken-word check dropped, so a clean tail buys a mangled word.
  it("test_take_that_clears_the_tail_but_breaks_a_word_is_rejected", async () => {
    const broken = CLEAN.replace("nid", "zzzzxq");
    const r = await run(CLEAN + STRAY, broken);
    expect(r.kept).toBe(false);
    expect(r.brokeWords).toContain("need");
  });

  // Mutation caught: regressions compares faulty-set membership instead of distances.
  it("test_already_faulty_word_getting_worse_is_also_a_regression", () => {
    const shipped = wordMap({ need: dist(0.5, true), here: dist(0.1, false) });
    const take = wordMap({ need: dist(0.9, true), here: dist(0.1, false) });
    expect(regressions(shipped, take)).toEqual(["need"]);
  });

  it("test_recognizer_noise_below_the_margin_is_not_a_regression", () => {
    const shipped = wordMap({ need: dist(0.5, true) });
    const take = wordMap({ need: dist(0.5 + WORSE_MARGIN / 2, true) });
    expect(regressions(shipped, take)).toEqual([]);
  });

  it("test_a_word_absent_from_shipped_counts_from_zero", () => {
    expect(regressions(wordMap({}), wordMap({ need: dist(0.9, true) }))).toEqual(["need"]);
  });

  // Mutation caught: every word is guarded, not only those the take leaves faulty.
  it("test_sub_threshold_drift_on_a_healthy_word_is_not_a_regression", () => {
    const shipped = wordMap({ across: dist(0.1, false) });
    const take = wordMap({ across: dist(0.4, false) });
    expect(regressions(shipped, take)).toEqual([]);
  });

  // Mutation caught: only the first candidate is tried.
  it("test_every_param_take_is_tried", async () => {
    const tried: string[] = [];
    const tracked: TailCandidate<string>[] = ["reseed", "temp0.85", "rep2.0"].map((label) => ({
      label,
      take: async () => {
        tried.push(label);
        return { value: label, phones: CLEAN };
      },
    }));
    await bestTailTake({ text: TEXT, shippedPhones: CLEAN + STRAY, before: { length: 3 }, candidates: tracked, g2p });
    expect(tried).toEqual(["reseed", "temp0.85", "rep2.0"]);
  });

  it("picks the take with fewer broken words before the shorter stray", async () => {
    const broken = CLEAN.replace("nid", "zzzzxq");
    const r = await run(CLEAN + STRAY, broken, CLEAN + "t");
    expect(r.label).toBe("t1");
    expect(r.brokeWords).toEqual([]);
  });
});

describe("keepTake", () => {
  const shipped = { brokeWords: 0, strayLength: 0, distance: 0.6 };

  // Mutation caught: `<=` in the margin comparison keeps the new take on a tie at margin = 0.
  it("keeps the shipped take on a tie at margin 0", () => {
    expect(keepTake(shipped, { ...shipped }, 0)).toBe(false);
  });

  it("keeps the shipped take on a tie in stray length", () => {
    const tail = { brokeWords: 0, strayLength: 3, distance: 0 };
    expect(keepTake(tail, { ...tail }, 0)).toBe(false);
  });

  it("requires the distance to fall by more than the margin", () => {
    expect(keepTake(shipped, { ...shipped, distance: 0.55 })).toBe(false);
    expect(keepTake(shipped, { ...shipped, distance: 0.5 })).toBe(true);
  });

  it("rejects a take that damages a word however short its stray", () => {
    const tail = { brokeWords: 0, strayLength: 3, distance: 0 };
    expect(keepTake(tail, { brokeWords: 1, strayLength: 0, distance: 0 })).toBe(false);
  });
});

// The audiobook backend's test_verified.py cases, under their pytest names.
describe("AB re-roll cases: synthesizeVerified", () => {
  // The recognizer replays one phone string per take: CLEAN, or CLEAN plus a babble run of `n` phones.
  const babble = (n: number) => CLEAN + "ʃ".repeat(n);
  const recognizerOf = (phones: string[]): PhoneRecognizer => {
    const queue = [...phones];
    return { recognize: async () => queue.shift() ?? CLEAN };
  };
  const harness = () => {
    const made: string[] = [];
    const discarded: string[] = [];
    return {
      made,
      discarded,
      options: {
        g2p,
        synthesize: async (attempt: number) => {
          const value = `take${attempt}`;
          made.push(value);
          return { value, audio: AUDIO };
        },
        discard: (value: string) => {
          discarded.push(value);
        },
      },
    };
  };

  it("test_clean_first_take_no_reroll", async () => {
    const h = harness();
    const r = await synthesizeVerified(TEXT, { ...h.options, recognizer: recognizerOf([CLEAN]) });
    expect(r).toMatchObject({ value: "take0", attempts: 1, clean: true });
    expect(h.made).toHaveLength(1);
  });

  it("test_rerolls_until_clean", async () => {
    const h = harness();
    const r = await synthesizeVerified(TEXT, { ...h.options, recognizer: recognizerOf([babble(6), babble(6), CLEAN]) });
    expect(r).toMatchObject({ value: "take2", attempts: 3, clean: true });
    expect(h.made).toHaveLength(3);
  });

  // Mutation caught: the last take is kept instead of the least severe.
  it("test_keeps_least_severe_when_never_clean", async () => {
    const h = harness();
    const r = await synthesizeVerified(TEXT, {
      ...h.options,
      retries: 2,
      recognizer: recognizerOf([babble(8), babble(6), babble(7)]),
    });
    expect(r).toMatchObject({ value: "take1", attempts: 3, clean: false });
    expect(h.made).toHaveLength(3);
  });

  it("test_falls_back_to_single_take_without_recognizer", async () => {
    const h = harness();
    const r = await synthesizeVerified(TEXT, h.options);
    expect(r).toMatchObject({ value: "take0", attempts: 1 });
    expect(h.made).toHaveLength(1);
  });

  // AB leaks a descriptor per take; here the equivalent resource is a take nobody discards.
  it("test_takes_do_not_leak_across_chunks", async () => {
    const h = harness();
    for (let i = 0; i < 25; i++) {
      await synthesizeVerified(TEXT, { ...h.options, recognizer: recognizerOf([babble(6), CLEAN]) });
    }
    expect(h.made).toHaveLength(50);
    expect(h.discarded).toHaveLength(25);
  });

  // Mutation caught: the winner is discarded with the losers, or a loser is not.
  it("test_takes_are_deleted_after_the_winner_is_copied_out", async () => {
    const h = harness();
    const r = await synthesizeVerified(TEXT, { ...h.options, recognizer: recognizerOf([babble(8), babble(6), CLEAN]) });
    expect(r.value).toBe("take2");
    expect(h.discarded.sort()).toEqual(["take0", "take1"]);
  });
});
