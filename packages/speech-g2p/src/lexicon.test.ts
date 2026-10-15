import { describe, expect, it } from "vitest";
import { Lexicon, parentTag, type Pronunciation, type TokenContext } from "./lexicon.js";
import { loadLexiconData } from "./lexicon-data.js";

// Expected values recorded from misaki 0.9.4 `Lexicon(british=False)` over the same vendored lexicon.
const lexicon = new Lexicon(loadLexiconData());
const ctx = (futureVowel: boolean | null = false, futureTo = false): TokenContext => ({ futureVowel, futureTo });
const read = (word: string, tag: string, context = ctx()): Pronunciation => lexicon.getWord(word, tag, null, context);

describe("parent tag fallback", () => {
  it("a tag absent from the word's dict falls back to its parent tag: live/VBP reads lˈɪv, use/NN reads jˈus", () => {
    expect(read("live", "VBP")).toEqual(["lˈɪv", 4]);
    expect(read("live", "NN")).toEqual(["lˈIv", 4]);
    expect(read("use", "NN")).toEqual(["jˈus", 4]);
    expect(read("use", "VB")).toEqual(["jˈuz", 4]);
  });

  it("a parent tag mapped to null spells the word out: US as a proper noun reads jˌuˈɛs", () => {
    expect(read("US", "NNP")).toEqual(["jˌuˈɛs", 3]);
    expect(read("US", "PRP")).toEqual(["ˌʌs", 4]);
  });

  it("a word with a None reading takes it when no word follows: by reads bˈI at the end, bI before a word", () => {
    expect(read("by", "IN", ctx(null))).toEqual(["bˈI", 4]);
    expect(read("by", "IN")).toEqual(["bI", 4]);
  });

  it("maps Penn tags to misaki's parent tags", () => {
    expect(["VBG", "NNS", "RBR", "JJS", "IN", null].map(parentTag)).toEqual(["VERB", "NOUN", "ADV", "ADJ", "IN", null]);
  });
});

describe("special cases", () => {
  it("used before to reads jˈust only with VBD or JJ", () => {
    expect(read("used", "VBD", ctx(false, true))).toEqual(["jˈust", 4]);
    expect(read("used", "JJ", ctx(false, true))).toEqual(["jˈust", 4]);
    expect(read("used", "VBD")).toEqual(["jˈuzd", 4]);
    expect(read("used", "VBN", ctx(false, true))).toEqual(["jˈuzd", 4]);
  });

  it("the, to, a, am, in and I read by the next word and their tag", () => {
    expect(read("the", "DT", ctx(true))[0]).toBe("ði");
    expect(read("the", "DT")[0]).toBe("ðə");
    expect(["to", "to", "to"].map((w, i) => read(w, "TO", ctx([null, true, false][i]))[0])).toEqual(["tu", "tʊ", "tə"]);
    expect(read("a", "DT")[0]).toBe("ɐ");
    expect(read("a", "NN")[0]).toBe("ˈA");
    expect(read("am", "VBP")[0]).toBe("ɐm");
    expect(read("am", "VBP", ctx(null))[0]).toBe("æm");
    expect(read("in", "IN")[0]).toBe("ɪn");
    expect(read("in", "RP")[0]).toBe("ˈɪn");
    expect(read("I", "PRP")).toEqual(["ˌI", 4]);
  });

  it("symbols are read as words and short dotted abbreviations are spelled out", () => {
    expect(read("&", "CC")).toEqual(["ænd", 4]);
    expect(read(".", "ADD")).toEqual(["dˌɑt", 4]);
    expect(read("vs.", "IN")).toEqual(["vˈɜɹsəs", 4]);
    expect(read("e.g.", "FW")).toEqual(["ˌiʤˈi", 3]);
  });
});

describe("capitalisation", () => {
  it("an all-caps word not in gold is looked up lowercase and spelled out when tagged NNP", () => {
    expect(lexicon.lookup("ABAY", "NNP", null, ctx())).toEqual(["ˌAbˌiˌAwˈI", 3]);
    expect(lexicon.lookup("ABAY", "NN", null, ctx())).toEqual(["əbˈA", 3]);
  });

  it("a capitalised word missing from both dicts reads as its known lowercase form", () => {
    expect(read("Cats", "NNS")).toEqual(["kˈæts", 3]);
    expect(read("Kicked", "VBD")).toEqual(["kˈɪkt", 3]);
  });
});

describe("stems", () => {
  it("adds -s, -ed and -ing to a known stem with misaki's voicing and flap rules", () => {
    expect(read("zorbs", "NNS")).toEqual(["zˈɔɹbz", 4]);
    expect(read("cats'", "NNS")).toEqual(["kˈæts", 3]);
    expect(read("zorbed", "VBD")).toEqual(["zˈɔɹbd", 4]);
    expect(read("waited", "VBD")).toEqual(["wˈAɾᵻd", 4]);
    expect(read("blarted", "VBD")).toEqual(["blˈɑɹɾᵻd", 3]);
    expect(read("ziping", "VBG")).toEqual(["zˈɪpɪŋ", 4]);
    expect(read("gitting", "VBG")).toEqual(["ɡˈɪɾɪŋ", 4]);
    expect(read("scrumming", "VBG")).toEqual(["skɹˈʌmɪŋ", 4]);
  });

  it("returns nulls for a word no stem rule reaches", () => {
    expect(read("zorbeds", "VBZ")).toEqual([null, null]);
  });
});
