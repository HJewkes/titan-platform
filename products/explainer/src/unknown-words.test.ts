import { describe, expect, it } from "vitest";
import { choppy } from "./rewrite-fixtures.test-helpers.js";
import { splitWord, unknownWordsHint, unknownWordsRow } from "./unknown-words.js";
import { doctrineG2p } from "./workflow/voice-g2p.js";

describe("unknown words as a repair row", () => {
  // Mutation: sorting the splits by the longer half suggests "shel fscan"-style splits or none.
  it("suggests the even split of a joined word whose halves the voice reads", () => {
    const g2p = doctrineG2p();

    const split = splitWord(g2p, "shelfscan");

    expect(split).toBe("shelf scan");
  });

  it("suggests no split when no pair of halves reads", () => {
    expect(splitWord(doctrineG2p(), "zqxjkv")).toBeUndefined();
  });

  // Mutation: passing the row on any script, or dropping its beats, lets the repair rounds skip the word.
  it("fails on a spoken word the voice has no phonemes for, naming its beat, and passes once it is split", () => {
    const joined = choppy({ h2: { spoken: "The desk checks every parcel with shelfscan today." } });
    const split = choppy({ h2: { spoken: "The desk checks every parcel with shelf scan today." } });

    const [before, after] = [unknownWordsRow(doctrineG2p(), joined), unknownWordsRow(doctrineG2p(), split)];

    expect(before).toMatchObject({ check_id: "unknown-words", severity: "error", pass: false, value: 1, detail_beats: ["h2"] });
    expect(after.pass).toBe(true);
  });

  it("hints each word with its beat and the split to write", () => {
    const script = choppy({ h2: { spoken: "The desk checks every parcel with shelfscan today." } });

    expect(unknownWordsHint(doctrineG2p(), script)).toMatch(/^the voice has no phonemes for h2 "shelfscan" \(write "shelf scan"\)\. Respell or split/);
  });
});
