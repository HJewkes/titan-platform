import { describe, expect, it } from "vitest";
import { applyLexicon } from "./apply-lexicon.js";
import { LexiconSchema } from "./lexicon.js";
import { splitLinks } from "./markup.js";
import { respeller, wholeWords } from "./respell.js";

const lexicon = LexiconSchema.parse({
  schema: "lexicon.v1",
  entries: [
    { term: "zorptrix", phonemes: { misaki: "zˈɔɹptɹɪks" }, respell: "zorptricks" },
    { term: "blenwick", respell: "blenwik" },
    { term: "quillor", spoken: "kwill-or", phonemes: { ipa: "kwɪlɔː" } },
  ],
});

describe("applyLexicon misaki", () => {
  it("wraps a declared term as an override and keeps the original casing", () => {
    expect(applyLexicon("The Zorptrix ran.", lexicon, "misaki")).toBe("The [Zorptrix](/zˈɔɹptɹɪks/) ran.");
  });

  it("leaves an occurrence already inside a link alone", () => {
    const spoken = "A [zorptrix](=noun) and a zorptrix.";
    expect(applyLexicon(spoken, lexicon, "misaki")).toBe("A [zorptrix](=noun) and a [zorptrix](/zˈɔɹptɹɪks/).");
  });

  it("does not double-wrap an occurrence inside an override link", () => {
    const spoken = "A [zorptrix](/zɔɹp/) ran.";
    expect(applyLexicon(spoken, lexicon, "misaki")).toBe(spoken);
  });

  it("ignores respell-only, spoken and ipa entries", () => {
    expect(applyLexicon("Blenwick and quillor.", lexicon, "misaki")).toBe("Blenwick and quillor.");
  });

  it("does not touch a term inside a longer word", () => {
    expect(applyLexicon("The zorptrixes ran.", lexicon, "misaki")).toBe("The zorptrixes ran.");
  });
});

describe("applyLexicon text", () => {
  it("strips markup and applies the respelling", () => {
    expect(applyLexicon("The [Blenwick](=noun) ran.", lexicon, "text")).toBe("The blenwik ran.");
  });

  it("never respells a substring of a longer word", () => {
    expect(applyLexicon("The zorptrixes ran.", lexicon, "text")).toBe("The zorptrixes ran.");
  });
});

describe("splitLinks", () => {
  it("round-trips the input and separates links from plain text", () => {
    const spoken = "one [two](=x) three [four](/f/)";
    const segments = splitLinks(spoken);
    expect(segments.map((s) => s.text).join("")).toBe(spoken);
    expect(segments.map((s) => s.kind)).toEqual(["plain", "link", "plain", "link"]);
  });

  it("returns one plain segment for unmarked text and none for empty text", () => {
    expect(splitLinks("no markup")).toEqual([{ kind: "plain", text: "no markup" }]);
    expect(splitLinks("")).toEqual([]);
  });
});

describe("wholeWords", () => {
  it("is null without keys and matches whole words only", () => {
    expect(wholeWords([])).toBeNull();
    expect("a cat catalog".match(wholeWords(["cat"])!)).toHaveLength(1);
    expect(respeller({ cat: "kat" }).apply("cat catalog")).toBe("kat catalog");
  });
});
