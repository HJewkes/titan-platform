import { describe, expect, it, vi } from "vitest";
import {
  admissiblePhones,
  cleanIpa,
  codePointLess,
  expectedPhones,
  g2pSentence,
  phoneMatchDistance,
  phonemeDistance,
  type PhoneG2p,
} from "./phones.js";
import { recordedG2p } from "./recorded-g2p.test-helpers.js";

// The audiobook backend's test_phonemes.py cases, under their pytest names.
describe("AB phone cases: cleaning and distance", () => {
  // Mutation caught: dropping ː (U+02D0) from the noise class.
  it("test_clean_ipa_strips_stress_and_length_marks", () => {
    expect(cleanIpa("wˈɪθənʃˌɔː")).toBe("wɪθənʃɔ");
    expect(cleanIpa("  ɹˈɛksəm  ")).toBe("ɹɛksəm");
  });

  // Mutation caught: dropping ɐ → ə from the allophone fold.
  it("test_clean_ipa_folds_flap_and_open_schwa", () => {
    expect(cleanIpa("bˈɛɾɐ")).toBe(cleanIpa("bˈɛtə"));
    expect(phonemeDistance("bɛɾɚ", "bɛtɚ")).toBe(0.0);
  });

  // Mutation caught: rewriting a syllabic consonant as consonant plus schwa (nə) instead of schwa first (ən).
  it("test_clean_ipa_folds_glottal_stop_and_syllabic_nasal", () => {
    expect(cleanIpa("sˈɜːʔn̩")).toBe("sɜtən");
    expect(cleanIpa("bˈɑːɾl̩")).toBe("bɑtəl");
    expect(phonemeDistance("bˈʌʔn̩", "bʌtən")).toBe(0.0);
  });

  // Mutation caught: folding d to t along with the flap.
  it("test_glottal_fold_keeps_t_d_contrast", () => {
    expect(phonemeDistance("bæt", "bæd")).toBeGreaterThan(0.0);
  });

  // Mutation caught: returning the ratio instead of 1 - ratio.
  it("test_phoneme_distance_identical_is_zero", () => {
    expect(phonemeDistance("wɪθənʃɔ", "wɪθənʃɔ")).toBe(0.0);
  });

  // Mutation caught: the same inversion; far would score below near.
  it("test_phoneme_distance_orders_similar_before_different", () => {
    const near = phonemeDistance("wɪθənʃɔ", "wɪðɪnʃɔ");
    const far = phonemeDistance("wɪθənʃɔ", "bɒʃtaɪstɪk");

    expect(near).toBeLessThan(far);
    expect(far).toBeGreaterThan(0.5);
  });

  // Mutation caught: expectedPhones returning "" (an unwired G2P).
  it("test_g2p_produces_phonemes_for_proper_noun_and_coinage", () => {
    const g2p = recordedG2p("test_g2p_produces_phonemes_for_proper_noun_and_coinage");

    expect(expectedPhones("Wrexham", { g2p })).not.toBe("");
    expect(expectedPhones("boshtastic", { g2p })).not.toBe("");
  });

  // Mutation caught: phonemeDistance comparing the inputs uncleaned and unequal-length as 0.
  it("test_g2p_distinguishes_distinct_words", () => {
    const g2p = recordedG2p("test_g2p_distinguishes_distinct_words");

    expect(phonemeDistance(expectedPhones("Wythenshawe", { g2p }), expectedPhones("boshtastic", { g2p }))).toBeGreaterThan(0.5);
  });

  // Mutation caught: scanning only the window of the expected length from the chunk start.
  it("test_phone_match_finds_word_inside_full_chunk_phones", () => {
    expect(phoneMatchDistance("wɪθənʃɔ", "haʊsɪnwɪθənʃɔəɡɛn")).toBeLessThan(0.15);
  });

  // Mutation caught: starting best at 0 instead of 1.
  it("test_phone_match_high_when_word_absent", () => {
    expect(phoneMatchDistance("wɪθənʃɔ", "bɒʃtaɪstɪkwɛmə")).toBeGreaterThan(0.5);
  });

  // Mutation caught: checking an empty chunk before an empty expected word (gives 1).
  it("test_phone_match_empty_expected_is_zero", () => {
    expect(phoneMatchDistance("", "anything")).toBe(0.0);
  });

  // A constructed name stands in for AB's, which comes from third-party text.
  // Mutation caught: looking weak forms up on a plain object, so the key is not stripped or lowercased first.
  it("test_only_function_words_carry_weak_forms", () => {
    expect(admissiblePhones("Jofar", "dʒɑfɑɹ")).toEqual(["dʒɑfɑɹ"]);
    expect(admissiblePhones("our", "aʊɚ")).toContain("ɑɹ");
    expect(admissiblePhones("Our,", "aʊɚ")).toContain("ɑɹ");
  });

  // AB reads the default from its settings; here it is the en-us default of the options.
  // Mutation caught: defaulting the voice to en-gb, or letting the default override an explicit voice.
  it("test_g2p_voice_defaults_to_the_configured_accent", () => {
    const g2p = vi.fn<PhoneG2p>(() => "");

    expectedPhones("over", { g2p });
    expectedPhones("over", { g2p, voice: "en-gb" });

    expect(g2p.mock.calls).toEqual([
      ["over", "en-us"],
      ["over", "en-gb"],
    ]);
  });
});

describe("Python semantics", () => {
  // Mutation caught: JavaScript's \s, which keeps U+0085 and strips U+FEFF.
  it("treats whitespace as Python's str does, removing U+0085 and keeping U+FEFF", () => {
    expect(cleanIpa("b\u0085ɛ t")).toBe("bɛt");
    expect(cleanIpa("b﻿ɛt")).toBe("b﻿ɛt");
  });

  // Mutation caught: splitting on / +/ or on JavaScript's \s, which joins words split by U+001F or splits on U+FEFF.
  it("splits sentence phones on Python whitespace only", () => {
    const g2p: PhoneG2p = () => "hˈɛ\u001Flo wɜ﻿ld\n";

    expect(g2pSentence("hello world", { g2p })).toEqual(["hɛ", "lo", "wɜ﻿ld"]);
  });

  // Mutation caught: trimming only ASCII punctuation, or stripping inner characters.
  it("strips AB's punctuation set from both ends of a weak-form key, by code point", () => {
    expect(admissiblePhones("—(our)…", "aʊɚ")).toEqual(["aʊɚ", "ɑɹ"]);
    expect(admissiblePhones("o-ur", "oʊəɹ")).toEqual(["oʊəɹ"]);
  });

  // Mutation caught: a weak-form table held in a plain object, where "constructor" finds Object's own.
  it("gives a word with an inherited object key only its citation form", () => {
    expect(admissiblePhones("constructor", "kənstɹʌktɚ")).toEqual(["kənstɹʌktɚ"]);
  });

  // Mutation caught: a < b on UTF-16 units, where a surrogate (U+D835) sorts before U+FF5A.
  it("orders strings by code point, as Python's < does", () => {
    expect(codePointLess("jm", "ɪm")).toBe(true);
    expect(codePointLess("ｚ", "\u{1D465}")).toBe(true);
    expect(codePointLess("ab", "abc")).toBe(true);
    expect(codePointLess("abc", "abc")).toBe(false);
  });
});
