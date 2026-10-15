import { whisperStt, type Segment, type Transcript } from "@titan-design/speech-stt";
import { describe, expect, it, vi } from "vitest";
import { numericValue, scanNumber } from "./defect-numbers.js";
import {
  confirmDefects,
  defectOptionsFor,
  detectDefects,
  isUnusualWord,
  tokenizeWords,
  type Defect,
  type DefectCause,
  type DefectKind,
  type DefectOptions,
  type WordToken,
} from "./defects.js";
import { phoneticDistance } from "./metaphone.js";

/** The audiobook's `_rich`: words at 0.5 s steps, each 0.4 s long. */
function rich(pairs: [string, number][], segments: Segment[] = []): Transcript {
  return {
    text: pairs.map(([w]) => w).join(" "),
    words: pairs.map(([text, probability], i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.4, probability })),
    segments,
  };
}

/** What a recogniser without token log-probs returns for the same audio. */
function stripped({ text, words }: Transcript): Transcript {
  return { text, words: words.map(({ text: word, start, end }) => ({ text: word, start, end })), segments: [] };
}

const confident =(sentence: string) => rich(sentence.split(" ").map((w): [string, number] => [w, 0.95]));
const kinds = (defects: Defect[]): DefectKind[] => defects.map((d) => d.kind);
const subs = (defects: Defect[]) => defects.filter((d) => d.kind === "substitution");

// The audiobook's inputs carry word probabilities, so its tests run with signal A on.
const ON: DefectOptions = { confidence: true };
const detect = (expected: string, transcript: Transcript) => detectDefects(expected, transcript, ON);

const MUDDY_SEGMENT: Segment = {
  start: 0.0,
  end: 2.0,
  text: "the empire stood firm",
  avgLogprob: -1.6,
  compressionRatio: 1.4,
  noSpeechProb: 0.01,
};

describe("the audiobook's test_defects cases", () => {
  it("test_phonetic_homophones_are_zero_distance", () => {
    expect(phoneticDistance("their", "there")).toBe(0.0);
    expect(phoneticDistance("dear", "deer")).toBe(0.0);
    expect(phoneticDistance("aegis", "eejis")).toBeGreaterThan(0.0);
  });

  it("test_numeric_value_maps_digits_and_words", () => {
    expect(numericValue("50")).toBe(50n);
    expect(numericValue("fifty")).toBe(50n);
    expect(numericValue("word")).toBeUndefined();
  });

  it("test_confident_homophone_is_not_flagged", () => {
    const transcript = rich([["they", 0.99], ["left", 0.98], ["there", 0.97], ["house", 0.98]]);
    expect(detect("they left their house", transcript)).toEqual([]);
  });

  it("test_digit_spoken_as_word_is_not_a_defect", () => {
    const transcript = rich([["chapter", 0.98], ["fifty", 0.95], ["begins", 0.97]]);
    expect(subs(detect("chapter 50 begins", transcript))).toEqual([]);
  });

  it("test_real_number_mangle_is_flagged", () => {
    const found = subs(detect("chapter 50 begins", rich([["chapter", 0.98], ["fifteen", 0.6], ["begins", 0.97]])));
    expect(found[0]?.expected).toBe("50");
    expect(found[0]?.causes).toContain<DefectCause>("number");
  });

  it("test_mangled_word_surfaces_with_low_confidence_boost", () => {
    const transcript = rich([["the", 0.99], ["eejis", 0.3], ["protected", 0.96], ["them", 0.95]]);
    const found = detect("the aegis protected them", transcript).filter((d) => d.expected === "aegis");
    expect(found[0]?.severity).toBeGreaterThan(0.3);
  });

  // The audiobook's input here may be book text; this constructed analogue reaches the same grouped path.
  it("test_count_mismatch_groups_into_single_defect", () => {
    const transcript = rich([["Hell", 0.5], ["P", 0.2], ["vella", 0.5], ["spoke", 0.95]]);
    const found = subs(detect("Heeeeeelp Vela spoke", transcript));
    expect(found).toHaveLength(1);
    expect(found[0]?.causes).toContain<DefectCause>("stylized_elongation");
  });

  it("test_low_confidence_segment_is_flagged_even_when_words_align", () => {
    const transcript = rich([["the", 0.9], ["empire", 0.9], ["stood", 0.9], ["firm", 0.9]], [MUDDY_SEGMENT]);
    expect(kinds(detect("the empire stood firm", transcript))).toContain<DefectKind>("low_confidence");
  });

  it("test_defects_sorted_by_severity_descending", () => {
    const transcript = rich([["the", 0.99], ["eejis", 0.3], ["of", 0.98], ["the", 0.98], ["zorptrix", 0.2], ["empire", 0.97]]);
    const severities = detect("the aegis of the foobarbaz empire", transcript).map((d) => d.severity);
    expect(severities).toEqual([...severities].sort((a, b) => b - a));
  });

  it("test_tokenize_collapses_elongation_but_keeps_original", () => {
    const [token] = tokenizeWords("Heeeeeelp");
    expect(token).toEqual<WordToken>({ original: "Heeeeeelp", norm: "help", start: 0 });
  });

  it("test_scan_number_parses_multiword_cardinals", () => {
    expect(scanNumber(["two", "hundred", "fifty"], 0)).toEqual([250n, 3]);
    expect(scanNumber(["one", "hundred", "forty", "nine"], 0)).toEqual([149n, 4]);
    expect(scanNumber(["thirty", "three"], 0)).toEqual([33n, 2]);
    expect(scanNumber(["50"], 0)).toEqual([50n, 1]);
    expect(scanNumber(["one", "thirty", "six"], 0)).toEqual([1n, 1]);
    expect(scanNumber(["seven", "thousand", "two", "hundred", "fifty"], 0)).toEqual([7250n, 5]);
    expect(scanNumber(["house"], 0)).toEqual([null, 0]);
    // Mutation caught: breaking at "hundred" unconditionally.
    expect(scanNumber(["three", "hundred", "twelve"], 0)).toEqual([312n, 3]);
  });

  it("test_multiword_number_not_flagged_when_spoken_correctly", () => {
    const transcript = rich([["he", 0.99], ["owed", 0.98], ["two", 0.9], ["hundred", 0.9], ["fifty", 0.9], ["gold", 0.97]]);
    expect(subs(detect("he owed 250 gold", transcript))).toEqual([]);
  });

  it("test_letter_read_as_its_name_is_not_flagged", () => {
    const transcript = rich([["grade", 0.98], ["see", 0.9], ["was", 0.97], ["fine", 0.97]]);
    expect(detect("grade C was fine", transcript).filter((d) => d.expected === "C")).toEqual([]);
  });

  it("test_defect_on_last_word_is_a_chunk_boundary_not_an_unusual_word", () => {
    const transcript = rich([["she", 0.98], ["needs", 0.97], ["the", 0.98], ["report", 0.96], ["zorptrix", 0.4]]);
    const found = detect("she needs the report ASAP.", transcript).filter((d) => d.expected === "ASAP");
    expect(found).toHaveLength(1);
    expect(found[0]?.causes).toContain<DefectCause>("chunk_boundary");
    expect(found[0]?.causes).not.toContain<DefectCause>("unusual_word");
  });

  it("test_confirm_keeps_defect_both_models_agree_on", () => {
    const expected = "the aegis protected them";
    const base = detect(expected, rich([["the", 0.99], ["eejis", 0.3], ["protected", 0.96], ["them", 0.95]]));
    const strong = rich([["the", 0.99], ["eejit", 0.6], ["protected", 0.98], ["them", 0.98]]);
    expect(confirmDefects(base, expected, strong, ON).some((d) => d.expected === "aegis")).toBe(true);
  });

  it("test_confirm_drops_base_only_false_positive", () => {
    const expected = "she left the house";
    const base = detect(expected, rich([["he", 0.4], ["left", 0.9], ["the", 0.9], ["house", 0.9]]));
    const strong = rich([["she", 0.95], ["left", 0.98], ["the", 0.98], ["house", 0.98]]);
    expect(base.some((d) => d.expected === "she")).toBe(true);
    expect(confirmDefects(base, expected, strong, ON)).toEqual([]);
  });

  it("test_confirm_returns_empty_when_no_base_defects", () => {
    expect(confirmDefects([], "clean audio", rich([["clean", 0.99], ["audio", 0.99]]), ON)).toEqual([]);
  });
});

describe("signal A behind the confidence flag", () => {
  const throwingLoader = vi.fn(() => Promise.reject(new Error("unit tests load no model")));
  const lowProbability = rich([["the", 0.3], ["empire", 0.3], ["stood", 0.3], ["firm", 0.3]], [MUDDY_SEGMENT]);

  // Mutation caught: whisperStt declaring tokenLogprobs true, or detectDefects ignoring the flag.
  it("gives whisperStt's transcripts no low-confidence segment and no severity boost", () => {
    const options = defectOptionsFor(whisperStt({ loadPipeline: throwingLoader }));
    const expected = "the empire stood fine";

    expect(options).toEqual({ confidence: false });
    expect(detectDefects(expected, lowProbability, options)).toEqual(detectDefects(expected, stripped(lowProbability), ON));
    expect(kinds(detectDefects(expected, lowProbability, options))).not.toContain<DefectKind>("low_confidence");
    expect(throwingLoader).not.toHaveBeenCalled();
  });

  it("reads both inputs when the provider declares token log-probs", () => {
    const options = defectOptionsFor({ capabilities: { tokenLogprobs: true } });
    const found = detectDefects("the empire stood fine", lowProbability, options);

    expect(options).toEqual({ confidence: true });
    expect(kinds(found)).toContain<DefectKind>("low_confidence");
    expect(found.find((d) => d.expected === "fine")?.severity).toBeGreaterThan(phoneticDistance("fine", "firm") * 0.7);
  });

  it("defaults to off", () => {
    expect(detectDefects("the empire stood firm", lowProbability)).toEqual([]);
  });
});

describe("number canonicalisation", () => {
  it("accepts 312 read as three hundred twelve", () => {
    expect(subs(detect("room 312 is locked", confident("room three hundred twelve is locked")))).toEqual([]);
  });

  it("keeps two different 20-digit numbers apart (T6)", () => {
    const found = detect("code 12345678901234567890 now", confident("code 12345678901234567891 now"));
    expect(found.map((d) => d.expected)).toEqual(["12345678901234567890"]);
  });
});

describe("Python semantics traps", () => {
  it("folds the letters Python's re.IGNORECASE folds into [a-z] (T1)", () => {
    const words = tokenizeWords("\u{17f}top \u{212a}ilt \u{130}zorp \u{131}x").map((t) => t.original);
    expect(words).toEqual(["\u{17f}top", "\u{212a}ilt", "\u{130}zorp", "\u{131}x"]);
  });

  it("counts offsets in code points (T2)", () => {
    expect(tokenizeWords("\u{1f600} ab")).toEqual([{ original: "ab", norm: "ab", start: 2 }]);
  });

  it("collapses Python's whitespace, \\x1f included, in the context (T5)", () => {
    const [found] = detect("the \x1f lantern swung", confident("the lanyard swung"));
    expect(found?.context).toBe("the lantern swung");
  });

  it("keeps equal severities in alignment order (T4)", () => {
    const found = detect("the mallet and the bucket fell", confident("the pallet and the tucket fell"));
    expect(found.map((d) => d.expected)).toEqual(["mallet", "bucket"]);
  });

  it("splits hyphenated words, so no defect is ever smushed (T7)", () => {
    expect(tokenizeWords("well-known").map((t) => t.norm)).toEqual(["well", "known"]);
    const found = detect("a well-known road", confident("a whale known road"));
    expect(found.flatMap((d) => d.causes)).not.toContain("smushed");
  });
});

describe("isUnusualWord", () => {
  it("flags capitalised words longer than three letters", () => {
    expect(isUnusualWord("Vela")).toBe(true);
    expect(isUnusualWord("Vel")).toBe(false);
    expect(isUnusualWord("vela")).toBe(false);
  });
});
