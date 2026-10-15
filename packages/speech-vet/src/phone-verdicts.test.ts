import { wav2vec2Recognizer } from "@titan-design/speech-stt";
import { describe, expect, it } from "vitest";
import replay from "./fixtures/phones-replay.golden.json" with { type: "json" };
import {
  chunkWordVerdicts,
  detectHallucinations,
  detectTailArtifact,
  indexMap,
  locate,
  recognizePhones,
  type WordVerdict,
} from "./phone-verdicts.js";
import { cleanIpa, codePoints, expectedPhones, g2pSentence, XTTS_FAULT_THRESHOLD, XTTS_FAULT_THRESHOLD_SHORT, type PhoneG2p } from "./phones.js";
import { recordedG2p } from "./recorded-g2p.test-helpers.js";

const byWord = (verdicts: WordVerdict[]) => new Map(verdicts.map((v) => [v.word.toLowerCase(), v]));
const fakeG2p =
  (phones: Readonly<Record<string, string>>): PhoneG2p =>
  (text) => {
    const ipa = phones[text];
    if (ipa === undefined) throw new Error(`unexpected G2P call for ${text}`);
    return ipa;
  };
const neverCalled: PhoneG2p = (text) => {
  throw new Error(`G2P called for ${text}`);
};

// The audiobook backend's test_phonemes.py cases, under their pytest names.
describe("AB phone cases: recognizer", () => {
  // AB's test writes an unfolded entry into its file cache; here the recognizer's cache holds one and the model never loads.
  // Mutation caught: recognizePhones returning the recognizer's raw decode.
  it("test_cached_phones_are_folded_on_read", async () => {
    const recognizer = wav2vec2Recognizer({
      cache: { get: () => "b ˈɛ ɾ ɐ", set: () => undefined },
      loadModel: () => Promise.reject(new Error("the model must not load")),
    });

    const phones = await recognizePhones(recognizer, { samples: new Float32Array(16_000), sampleRate: 16_000 });

    expect(phones).toBe("bɛtə");
  });
});

describe("AB phone cases: word verdicts", () => {
  // Mutation caught: scoring the word's best window anywhere in the chunk instead of its aligned span.
  it("test_positional_verdict_flags_garbled_word_not_neighbours", () => {
    const g2p = recordedG2p("test_positional_verdict_flags_garbled_word_not_neighbours");
    const text = "the match in Bochum ended";
    const parts = g2pSentence(text, { g2p });
    parts[3] = "zzzzxq";

    const verdicts = byWord(chunkWordVerdicts(text, parts.join(""), { g2p, targets: ["Bochum", "match"] }));

    expect(verdicts.get("bochum")?.source).toBe("xtts");
    expect(verdicts.get("match")?.source).toBe("whisper");
  });

  // Mutation caught: scoring the citation form alone.
  it("test_reduced_function_word_is_not_a_fault", () => {
    const g2p = recordedG2p("test_reduced_function_word_is_not_a_fault");
    const text = "we kept our heads";
    const parts = g2pSentence(text, { g2p });
    parts[2] = "ɑɹ";

    const [verdict] = chunkWordVerdicts(text, parts.join(""), { g2p, targets: ["our"] });

    expect(verdict?.source).toBe("whisper");
    expect(verdict?.distance).toBe(0.0);
  });

  // Mutation caught: taking the largest distance's form, or any weak-form word as correct.
  it("test_weak_form_does_not_rescue_a_genuine_mismatch", () => {
    const g2p = recordedG2p("test_weak_form_does_not_rescue_a_genuine_mismatch");
    const text = "they have the ball";
    const parts = g2pSentence(text, { g2p });
    parts[1] = "ɪf";

    expect(chunkWordVerdicts(text, parts.join(""), { g2p, targets: ["have"] })[0]?.source).toBe("xtts");
  });

  // Mutation caught: treating no targets as every word of the chunk.
  it("test_verdict_without_targets_returns_empty", () => {
    const g2p = recordedG2p("test_verdict_without_targets_returns_empty");

    expect(chunkWordVerdicts("hello world", "hɛloʊwɜld", { g2p })).toEqual([]);
  });

  // Mutation caught: dropping the short-word guard (expected phones >= MIN_PHONES_FOR_VERDICT).
  it("test_short_word_not_called_xtts_fault_despite_high_distance", () => {
    const g2p = recordedG2p("test_short_word_not_called_xtts_fault_despite_high_distance");
    const text = "I am here";
    const parts = g2pSentence(text, { g2p });
    parts[0] = "z";

    const verdicts = byWord(chunkWordVerdicts(text, parts.join(""), { g2p, targets: ["I"] }));

    expect(verdicts.get("i")?.source).toBe("whisper");
  });

  // Mutation caught: ignoring `unusual`, so the tagged verdict stays xtts.
  it("test_unusual_word_needs_a_bigger_gap_before_it_is_called_an_xtts_fault", () => {
    const g2p = recordedG2p("test_unusual_word_needs_a_bigger_gap_before_it_is_called_an_xtts_fault");
    const text = "the match in Bochum ended";
    const parts = g2pSentence(text, { g2p });
    parts[3] = "boʊkəm";
    const actual = parts.join("");

    const [plain] = chunkWordVerdicts(text, actual, { g2p, targets: ["Bochum"] });
    const [tagged] = chunkWordVerdicts(text, actual, { g2p, targets: ["Bochum"], unusual: ["Bochum"] });

    expect(plain?.distance).toBe(tagged?.distance);
    expect(plain?.source).toBe("xtts");
    expect(tagged?.source).toBe("whisper");
  });

  // AB switches its configured accent; here the voice is passed.
  // Mutation caught: chunkWordVerdicts ignoring `voice` and always predicting en-us.
  it("test_configured_accent_decides_whether_rhotic_audio_is_a_fault", () => {
    const g2p = recordedG2p("test_configured_accent_decides_whether_rhotic_audio_is_a_fault");
    const text = "his career was over";
    const actual = g2pSentence(text, { g2p, voice: "en-us" }).join("");

    expect(chunkWordVerdicts(text, actual, { g2p, voice: "en-us", targets: ["career"] })[0]?.source).toBe("whisper");
    expect(chunkWordVerdicts(text, actual, { g2p, voice: "en-gb", targets: ["career"] })[0]?.source).toBe("xtts");
  });

  // Mutation caught: judging short words at the ordinary 0.45, so the near swap becomes xtts.
  it("test_short_word_needs_a_wider_gap_than_a_long_one", () => {
    const g2p = recordedG2p("test_short_word_needs_a_wider_gap_than_a_long_one");
    const text = '"Dye Hard," I said.';
    const swapped = g2pSentence(text, { g2p });
    const near = g2pSentence(text, { g2p });
    swapped[0] = "ɡɹu";
    near[0] = "zɔɪn";

    expect(chunkWordVerdicts(text, swapped.join(""), { g2p, targets: ["Dye"] })[0]?.source).toBe("xtts");
    expect(chunkWordVerdicts(text, near.join(""), { g2p, targets: ["Dye"] })[0]?.source).toBe("whisper");
  });

  // Mutation caught: applying the short threshold to every word.
  it("test_long_word_keeps_the_ordinary_threshold", () => {
    const g2p = recordedG2p("test_long_word_keeps_the_ordinary_threshold");
    const text = "the match in Salford ended";
    const parts = g2pSentence(text, { g2p });
    parts[3] = "sɑlvɚt";

    const [verdict] = chunkWordVerdicts(text, parts.join(""), { g2p, targets: ["Salford"] });

    expect(verdict?.distance).toBeGreaterThanOrEqual(XTTS_FAULT_THRESHOLD);
    expect(verdict?.distance).toBeLessThan(XTTS_FAULT_THRESHOLD_SHORT);
    expect(verdict?.source).toBe("xtts");
  });

  // AB's case quotes third-party text; this is the owner-authored analogue from phones-replay.golden.json.
  // Mutation caught: indexMap's j1 + ... + 1 off-by-one, which widens the span past the guard and gives xtts.
  it("test_degenerate_span_from_duplicate_prefix_is_inconclusive_not_xtts", () => {
    const g2p = recordedG2p("test_degenerate_span_from_duplicate_prefix_is_inconclusive_not_xtts");
    const analogue = replay.cases.find((c) => c.id === "analogue-duplicate-prefix")!;

    const verdicts = byWord(chunkWordVerdicts(analogue.text, analogue.raw, { g2p, targets: ["Jofar"] }));

    expect(verdicts.get("jofar")?.source).toBe("inconclusive");
  });
});

describe("AB phone cases: hallucinations", () => {
  // Mutation caught: reporting only replace opcodes, which misses a pure insertion.
  it("test_detect_hallucination_flags_inserted_babble", () => {
    const g2p = recordedG2p("test_detect_hallucination_flags_inserted_babble");
    const text = "absolutely perfect Heli eyed me";
    const parts = g2pSentence(text, { g2p });
    parts.splice(2, 0, "wʌnʃɹi");

    const found = detectHallucinations(text, parts.join(""), { g2p });

    expect(found.some((h) => h.phones.includes("wʌnʃɹi"))).toBe(true);
    expect(found[0]?.length).toBeGreaterThanOrEqual(5);
  });

  // Mutation caught: reporting every replace opcode as babble.
  it("test_clean_audio_has_no_hallucination", () => {
    const g2p = recordedG2p("test_clean_audio_has_no_hallucination");
    const text = "absolutely perfect Heli eyed me";

    expect(detectHallucinations(text, g2pSentence(text, { g2p }).join(""), { g2p })).toEqual([]);
  });
});

describe("AB phone cases: tail artifacts", () => {
  const tailText = "we need to get him here";

  // Mutation caught: requiring HALLUCINATION_MIN_PHONES (5) for a tail run.
  it("test_tail_artifact_flags_phantom_syllable_after_last_word", () => {
    const g2p = recordedG2p("test_tail_artifact_flags_phantom_syllable_after_last_word");

    const artifact = detectTailArtifact(tailText, cleanIpa(expectedPhones(tailText, { g2p })) + "tʃə", { g2p });

    expect(artifact?.phones).toBe("tʃə");
    expect(artifact?.length).toBe(3);
  });

  // Mutation caught: flagging a final equal opcode.
  it("test_clean_tail_is_not_an_artifact", () => {
    const g2p = recordedG2p("test_clean_tail_is_not_an_artifact");

    expect(detectTailArtifact(tailText, cleanIpa(expectedPhones(tailText, { g2p })), { g2p })).toBeNull();
  });

  // Mutation caught: TAIL_STRAY_MIN_PHONES raised to 2.
  it("test_single_stray_phone_is_a_tail_artifact", () => {
    const g2p = recordedG2p("test_single_stray_phone_is_a_tail_artifact");

    expect(detectTailArtifact(tailText, cleanIpa(expectedPhones(tailText, { g2p })) + "t", { g2p })?.phones).toBe("t");
  });

  // Mutation caught: exempting a stray that repeats the last expected phone.
  it("test_stray_echoing_the_final_phone_still_counts", () => {
    const g2p = recordedG2p("test_stray_echoing_the_final_phone_still_counts");
    const text = "hegemony over English women's football";

    expect(detectTailArtifact(text, cleanIpa(expectedPhones(text, { g2p })) + "l", { g2p })).not.toBeNull();
  });

  // Mutation caught: < instead of <= against the displaced phones.
  it("test_mispronounced_last_word_is_not_a_tail_artifact", () => {
    const g2p = recordedG2p("test_mispronounced_last_word_is_not_a_tail_artifact");
    const text = "the same career paths";
    const actual = codePoints(cleanIpa(expectedPhones(text, { g2p }))).slice(0, -4).join("") + "ɑðz";

    expect(detectTailArtifact(text, actual, { g2p })).toBeNull();
  });

  // Mutation caught: dropping the ends-in-digit guard.
  it("test_ordinal_reading_of_a_final_digit_is_not_a_tail_artifact", () => {
    const g2p = recordedG2p("test_ordinal_reading_of_a_final_digit_is_not_a_tail_artifact");

    expect(detectTailArtifact("Wednesday, May 2", cleanIpa(expectedPhones("Wednesday, May second", { g2p })), { g2p })).toBeNull();
  });

  // The digit guard returns before any G2P call, so AB recorded the phones only for the actual side.
  // Mutation caught: \d$ without the \W* run, which misses the ] after "rated 8".
  it.each(["the final score was 8", "the C A 74.", "added time 90+2", "rated 8]"])(
    "test_chunks_ending_in_a_digit_are_never_tail_artifacts[%s]",
    (text) => {
      const g2p = recordedG2p(`test_chunks_ending_in_a_digit_are_never_tail_artifacts[${text}]`);

      expect(detectTailArtifact(text, cleanIpa(expectedPhones(text, { g2p })) + "tʃə", { g2p })).toBeNull();
    },
  );

  // Mutation caught: a digit anywhere in the text disabling the check.
  it("test_digit_inside_a_chunk_does_not_disable_tail_detection", () => {
    const g2p = recordedG2p("test_digit_inside_a_chunk_does_not_disable_tail_detection");
    const text = "he scored 2 goals before the break";

    expect(detectTailArtifact(text, cleanIpa(expectedPhones(text, { g2p })) + "tʃə", { g2p })).not.toBeNull();
  });
});

describe("Python semantics in the verdicts", () => {
  // Mutation caught: localeCompare, which sorts ɪ before j and reports the weak form ɪm.
  it("breaks a distance tie between citation and weak form toward the code-point-smaller form", () => {
    const g2p = fakeG2p({ him: "jm" });

    const [verdict] = chunkWordVerdicts("him", "xm", { g2p, targets: ["him"] });

    expect(verdict).toEqual({ word: "him", expectedPhones: "jm", actualPhones: "xm", distance: 0.5, source: "whisper" });
  });

  // Mutation caught: Math.round in indexMap, which maps the middle phone to 2.
  it("truncates a fractional aligned index as Python's int() does", () => {
    expect(indexMap(codePoints("abc"), codePoints("xxxxx"))).toEqual([0, 1, 3]);
  });

  // Mutation caught: reading mapping[hi - 1] past the end, which gives an empty span.
  it("maps a word longer than the chunk's phones to the end of the audio", () => {
    const g2p = fakeG2p({ ab: "ab", abcd: "abcd" });

    expect(locate(codePoints("abcd"), codePoints("ab"))).toEqual([0, 4]);
    expect(chunkWordVerdicts("ab", "abxyz", { g2p, targets: ["abcd"] })).toEqual([
      { word: "abcd", expectedPhones: "abcd", actualPhones: "abxyz", distance: 0.556, source: "whisper" },
    ]);
  });

  // Mutation caught: UTF-16 lengths, which count each astral phone twice (length 10, position 0.17).
  it("counts phones by code point", () => {
    const g2p = fakeG2p({ ab: "ab" });

    expect(detectHallucinations("ab", "ab" + "\u{1D465}".repeat(5), { g2p })).toEqual([
      { phones: "\u{1D465}".repeat(5), length: 5, position: 0.29, severity: 0.5 },
    ]);
  });

  // Mutation caught: an ASCII \d, which misses the Arabic-Indic digit three.
  it("treats a final digit of any script as ending in a digit, before calling the G2P", () => {
    expect(detectTailArtifact("rated 8]", "abc", { g2p: neverCalled })).toBeNull();
    expect(detectTailArtifact("rated ٣", "abc", { g2p: neverCalled })).toBeNull();
  });

  // Mutation caught: [^\p{L}\p{Nd}_] for \W, which reads the superscript two as punctuation after the 9.
  it("counts a superscript numeral as a word character, as Python's \\W does", () => {
    const g2p = fakeG2p({ "rated 9²": "a" });

    expect(detectTailArtifact("rated 9²", "ab", { g2p })).toEqual({ phones: "b", length: 1, displaced: "", severity: 0.5 });
  });
});
