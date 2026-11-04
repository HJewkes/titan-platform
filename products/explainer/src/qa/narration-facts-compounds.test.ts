import { describe, expect, it } from "vitest";
import { spokenValues, unspokenFacts, type ScreenText } from "./narration-facts.js";

const label = (text: string, cls = "ex-label"): ScreenText => ({ text, tag: "span", cls });
const facts = (texts: ScreenText[], spoken: string) => unspokenFacts("b1", texts, spoken).map(({ kind, fact }) => `${kind}:${fact}`);

describe("spoken numbers inside hyphenated compounds", () => {
  it("hears the leading number of a compound that goes on with other words", () => {
    const values = spokenValues("a twenty-cycle limit, a twenty-one-cycle limit, a five-minute wait, a two-hundred-page book");

    expect([...values].sort((a, b) => a - b)).toEqual(expect.arrayContaining([5, 20, 21, 200]));
  });

  it("ends the run at the compound so the next number is its own value", () => {
    const values = spokenValues("twenty-cycle two");

    expect([...values].sort((a, b) => a - b)).toEqual([2, 20]);
  });

  it("hears a fully spelled hyphenated number as before", () => {
    expect([...spokenValues("twenty-one lanes")]).toEqual([21]);
  });

  it("hears no number when the compound does not start with one", () => {
    expect([...spokenValues("a post-twenty cycle-twenty lane")]).toEqual([]);
  });

  it("does not hear a count in the idiom one-off", () => {
    expect([...spokenValues("a one-off fix")]).toEqual([]);
  });

  it("clears a shown number that the narration says inside a compound", () => {
    const spoken = "Held skips used to burn the twenty-cycle settle limit";

    expect(facts([label("20 cycles")], spoken)).toEqual([]);
  });
});
