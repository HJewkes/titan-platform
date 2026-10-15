import { describe, expect, it } from "vitest";
import { governingTag, punctTag, wordTag } from "./penn-rules.js";

const none = { governing: null, nextWord: undefined };
const tok = (text: string, whitespace = " ") => ({ text, idx: 0, whitespace });

describe("wordTag", () => {
  it("tags a and an as determiners whatever compromise says", () => {
    expect(wordTag("a", new Set(["Value"]), none)).toBe("DT");
  });

  it("tags that as a determiner only when compromise calls it a pronoun", () => {
    expect(wordTag("that", new Set(["Pronoun"]), none)).toBe("DT");
    expect(wordTag("that", new Set(["Conjunction"]), none)).toBe("IN");
  });

  it("tags in as a particle only with the Particle tag", () => {
    expect(wordTag("in", new Set(["Particle"]), none)).toBe("RP");
    expect(wordTag("in", new Set(["Preposition"]), none)).toBe("IN");
  });

  it("tags used before to as VBD even when compromise says otherwise", () => {
    expect(wordTag("used", new Set(["Adjective"]), { governing: null, nextWord: "to" })).toBe("VBD");
  });

  it("tags a verb after a modal as VB despite a past-tense tag", () => {
    const tags = new Set(["Verb", "PastTense"]);
    expect(wordTag("read", tags, { governing: "MD", nextWord: undefined })).toBe("VB");
    expect(wordTag("read", tags, { governing: null, nextWord: undefined })).toBe("VBD");
  });
});

describe("governingTag", () => {
  it("steps back over adverbs to a modal", () => {
    expect(governingTag(["PRP", "MD", "RB", "RB"], ["it", "can", "not", "easily"])).toBe("MD");
  });

  it("identifies a do-form by its word", () => {
    expect(governingTag(["PRP", "VBD", "RB"], ["we", "did", "n't"])).toBe("DO");
  });

  it("stops at any other tag", () => {
    expect(governingTag(["MD", "NN"], ["can", "dog"])).toBe("NN");
  });
});

describe("punctTag", () => {
  it("opens a quote after whitespace and closes it when attached", () => {
    expect(punctTag(tok('"', ""), undefined)).toBe("``");
    expect(punctTag(tok('"'), tok("hi", ""))).toBe("''");
  });

  it("tags an unspaced hyphen as HYPH and a spaced one as a colon", () => {
    expect(punctTag(tok("-", ""), tok("well", ""))).toBe("HYPH");
    expect(punctTag(tok("-"), tok("well"))).toBe(":");
  });
});
