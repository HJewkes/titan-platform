import { describe, expect, it } from "vitest";
import { MisakiEngine } from "./engine.js";
import { Lexicon } from "./lexicon.js";
import { loadLexiconData } from "./lexicon-data.js";
import { alignB2A, preprocess, subtokenize, type TaggedToken } from "./pipeline.js";
import type { G2pToken } from "./types.js";

// Expected values recorded from misaki 0.9.4 `G2P(fallback=None, unk="")`, whose spaCy tags match the ones injected here.
const lexicon = new Lexicon(loadLexiconData());

/** Phonemizes `text`, with the tokenizer and tagger replaced by `[text, tag, whitespace]` triples. */
function phonemize(text: string, tagged: readonly (readonly [string, string, string?])[]): G2pToken[] {
  const analyze = (pre: string): TaggedToken[] => {
    let idx = 0;
    const tokens = tagged.map(([t, tag, whitespace = " "]) => {
      const token = { text: t, idx, whitespace, tag };
      idx += t.length + whitespace.length;
      return token;
    });
    expect(tokens.map((t) => t.text + t.whitespace).join("")).toBe(pre);
    return tokens;
  };
  return new MisakiEngine({ lexicon, analyze, unk: "" }).phonemize(text).tokens;
}

const phonemesOf = (tokens: readonly G2pToken[]): (string | null)[] => tokens.map((t) => t.phonemes);

describe("preprocess", () => {
  it("strips link markup to its text and records overrides, stress and flags by word index", () => {
    const pre = preprocess("  A [word](#flag#) and [cache layer](/kˈæʃ lˈAɚ//) [up](+2) [x](-0.5) [y](https://e.com)");
    expect(pre.text).toBe("A word and cache layer up x y");
    expect(pre.words).toEqual(["A", "word", "and", "cache layer", "up", "x", "y"]);
    expect([...pre.features]).toEqual([[1, "#flag"], [3, "/kˈæʃ lˈAɚ"], [4, 2], [5, -0.5]]);
  });
});

describe("alignB2A", () => {
  it("maps each spaCy token to the words it shares characters with, a link's words to one word", () => {
    expect(alignB2A(["cache layer", "x"], ["cache", "layer", "x"])).toEqual([[0], [0], [1]]);
  });

  it("gives a whitespace-only token no word, which is what shifts misaki's flattened indices", () => {
    expect(alignB2A(["a", "b"], ["a", " ", "b"])).toEqual([[0], [], [1]]);
  });
});

describe("subtokenize", () => {
  it("splits at case changes, digit runs, hyphens and apostrophes like misaki's regex", () => {
    expect(subtokenize("GitHub's")).toEqual(["Git", "Hub's"]);
    expect(subtokenize("HTTPServers2go")).toEqual(["HTTPServers", "2", "go"]);
    expect(subtokenize("-4.5x")).toEqual(["-4.5", "x"]);
    expect(subtokenize("well-known")).toEqual(["well", "-", "known"]);
  });
});

describe("misaki pipeline", () => {
  it("an override keeps its phonemes verbatim with rating 5, and the word before it sees them", () => {
    const tokens = phonemize("the [one](/ˈɑn/)", [["the", "DT"], ["one", "NN", ""]]);
    expect(tokens[1]).toEqual({ text: "one", tag: "NN", phonemes: "ˈɑn", whitespace: "", rating: 5 });
    expect(tokens[0]!.phonemes).toBe("ði");
  });

  it("an override over two tokens folds them into one token", () => {
    const tokens = phonemize("[cache layer](/kˈæʃ lˈAɚ/) works", [["cache", "NN"], ["layer", "NN"], ["works", "VBZ", ""]]);
    expect(tokens.slice(0, 1)).toEqual([{ text: "cache layer", tag: "NN", phonemes: "kˈæʃ lˈAɚ", whitespace: " ", rating: 5 }]);
  });

  it("the before a vowel-initial word reads ði, before a consonant ðə", () => {
    const tokens = phonemize("the apple and the pear", [["the", "DT"], ["apple", "NN"], ["and", "CC"], ["the", "DT"], ["pear", "NN", ""]]);
    expect(phonemesOf(tokens)).toEqual(["ði", "ˈæpᵊl", "ænd", "ðə", "pˈɛɹ"]);
  });

  it("a hyphenated compound reads its parts and demotes the weaker stress", () => {
    const tokens = phonemize("fix-first", [["fix", "NN", ""], ["-", "HYPH", ""], ["first", "JJ", ""]]);
    expect(phonemesOf(tokens)).toEqual(["fˌɪksfˈɜɹst"]);
  });

  it("a slash keeps a space between the parts it joins, and no part is destressed", () => {
    const tokens = phonemize("Take 1/2 now", [["Take", "VB"], ["1/2", "CD"], ["now", "RB", ""]]);
    expect(tokens[1]!.phonemes).toBe("wˈʌn tˈu");
  });

  it("live/VBP reads lˈɪv through the VERB entry, not the default lˈIv", () => {
    const tokens = phonemize("we live here", [["we", "PRP"], ["live", "VBP"], ["here", "RB", ""]]);
    expect(tokens[1]!.phonemes).toBe("lˈɪv");
  });

  it("a currency symbol reads after its amount and flaps become T", () => {
    const tokens = phonemize("$5 a bottle", [["$", "$", ""], ["5", "CD"], ["a", "DT"], ["bottle", "NN", ""]]);
    expect(phonemesOf(tokens)).toEqual(["", "fˈIv dˈɑləɹz", "ɐ", "bˈɑTəl"]);
  });
});
