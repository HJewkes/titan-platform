import { describe, expect, it } from "vitest";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { hasSpokenDigits, numberForms, spellSpokenNumbers, spokenDigitsCheck } from "./spoken-numbers.js";
import { deriveEvalView } from "./eval-view.js";

const beatOf = (spoken: string, cues: string[] = []) => {
  const script = ScriptSchema.parse(
    scriptWith({
      spoken,
      visual: { assertion: "The desk keeps a tally", job: "numbers", cues: cues.map((atCue) => ({ action: "V6", target: "desk", atCue })) },
    }),
  );
  return script.beats[0]!;
};
const spell = (spoken: string) => spellSpokenNumbers(beatOf(spoken)).spoken;
const cuesOf = (spoken: string, cues: string[]) => spellSpokenNumbers(beatOf(spoken, cues)).visual.cues.map((c) => c.atCue);

describe("spellSpokenNumbers", () => {
  it("spells small and large cardinals alike", () => {
    // Catches: a missing 0-99 step, which speech-vet's cardinals leave as digits.
    expect(spell("It took 3 runs and 143 retries.")).toBe("It took three runs and one hundred forty-three retries.");
  });

  it("reads a year as a pair of numbers", () => {
    expect(spell("The desk opened in 2026.")).toBe("The desk opened in twenty twenty-six.");
    expect(spell("It closed in 1905, then 2003.")).toBe("It closed in nineteen oh five, then two thousand three.");
  });

  it("voices a four-digit id as digit pairs and a plain count as a cardinal", () => {
    // Catches: reading an id as a cardinal, which says "two thousand three hundred twenty-four" for PR 2324.
    expect(spell("PR 2324 closed.")).toBe("PR twenty-three twenty-four closed.");
    expect(spell("See TP-4103, then issue #1152.")).toBe("See TP forty-one oh three, then issue number eleven fifty-two.");
    expect(spell("It is #1152 or pull request 4100.")).toBe("It is number eleven fifty-two or pull request forty-one hundred.");
    expect(spell("The table has 2,324 rows.")).toBe("The table has two thousand three hundred twenty-four rows.");
  });

  it("keeps a cue after an id on its word and puts a cue on the id at the id's first word", () => {
    expect(cuesOf("Ship PR 2324 now.", ["now"])).toEqual(["now"]);
    expect(cuesOf("Ship PR 2324 now.", ["2324"])).toEqual(["PR"]);
  });

  it("spells percent, ordinals and decimals", () => {
    expect(spell("Half of the 2nd batch, 3.5 percent or 40% of it.")).toBe(
      "Half of the second batch, three point five percent or forty percent of it.",
    );
  });

  it("reads a range as from one number to the other", () => {
    // Catches: spelling each side and keeping the dash, which the voice reads as "thirty thirty-five percent".
    expect(spell("About 30–35% of heads stall.")).toBe("About thirty to thirty-five percent of heads stall.");
    expect(spell("It ran 2020–2026 for $5–$10 each.")).toBe("It ran twenty twenty to twenty twenty-six for five dollars to ten dollars each.");
  });

  it("moves a cue on a range to its first word", () => {
    expect(cuesOf("About 30–35% of heads stall.", ["30–35%"])).toEqual(["thirty"]);
    expect(cuesOf("About 30–35% of heads stall.", ["heads"])).toEqual(["heads"]);
  });

  it("spells an amount with its magnitude word or spaced symbol as one number", () => {
    // Catches: spelling word by word, which reads "$1.4 million" as "one point four dollars million".
    expect(spell("It cost $1.4 million, then $ 5 and $2 billion.")).toBe("It cost one point four million dollars, then five dollars and two billion dollars.");
    expect(spell("About 40 % of scans failed.")).toBe("About forty percent of scans failed.");
  });

  it("leaves markup alone", () => {
    expect(spell("The [desk 7](=queue) holds 4 scans.")).toBe("The [desk 7](=queue) holds four scans.");
  });

  it("moves a cue on a digit to the first word of its spelling", () => {
    expect(cuesOf("The desk keeps 143 scans.", ["143"])).toEqual(["one"]);
  });

  it("keeps a numbered cue naming the same word after an earlier digit becomes that word", () => {
    // Catches: skipping the cue remap, which leaves "one" pointing at the spelled-out digit.
    expect(cuesOf("After 1 try the one desk stays.", ["one"])).toEqual(["one#2"]);
  });

  it("leaves a cue on an unchanged word alone when spelling adds words before it", () => {
    expect(cuesOf("It took 21 and 21 scans.", ["scans"])).toEqual(["scans"]);
  });

  it("moves a cue on a grouped number or its magnitude word to the amount's first word", () => {
    expect(cuesOf("It cost $1.4 million to run.", ["$1.4"])).toEqual(["one"]);
    expect(cuesOf("It cost $1.4 million to run.", ["million"])).toEqual(["one"]);
    expect(cuesOf("About 40 % of scans failed.", ["scans"])).toEqual(["scans"]);
  });

  it("leaves a beat with no digits as the same object", () => {
    const beat = beatOf("The desk keeps a tally.");
    expect(spellSpokenNumbers(beat)).toBe(beat);
  });

  it("produces a beat the schema still accepts", () => {
    const script = ScriptSchema.parse(
      scriptWith({ spoken: "After 1 try the 2026 desk keeps 143 scans.", visual: { assertion: "A tally", job: "numbers", cues: [{ action: "V6", target: "desk", atCue: "scans" }] } }),
    );
    const spelled = { ...script, beats: script.beats.map(spellSpokenNumbers) };
    expect(() => ScriptSchema.parse(spelled)).not.toThrow();
  });
});

describe("Q-V12 spoken digits", () => {
  const rowFor = (spoken: string) => {
    const script = ScriptSchema.parse(scriptWith({ spoken }));
    return spokenDigitsCheck({ script, view: deriveEvalView(script) });
  };

  it("lists a beat that holds a digit", () => {
    expect(rowFor("The desk keeps 3 scans.")).toMatchObject([{ check_id: "Q-V12", severity: "error", pass: false, detail_beats: ["c2-1-stations"] }]);
  });

  it("passes a spelled beat and one whose only digits sit in markup", () => {
    expect(rowFor("The desk keeps three scans.")[0]).toMatchObject({ pass: true });
    expect(hasSpokenDigits("The [desk 7](=queue) is fine.")).toBe(false);
  });
});

describe("numberForms", () => {
  it("reads back every whole number the speller writes, years read as pairs included", () => {
    const misread = Array.from({ length: 2101 }, (_, n) => n)
      .concat([5000, 12_345, 1_400_000])
      .filter((n) => numberForms(spell(`${n} rows.`).replace(/ rows\.$/, "")).join() !== String(n));
    expect(misread).toEqual([]);
  });

  it("gives a spelled mention and its digits one form", () => {
    expect(numberForms("twenty-eight")).toEqual(numberForms("28"));
    expect(numberForms("a hundred and ninety")).toEqual(["190"]);
    expect(numberForms("Forty-four")).toEqual(["44"]);
    expect(numberForms("1,200")).toEqual(["1200"]);
    expect(numberForms("forty percent")).toEqual(numberForms("40%"));
    expect(numberForms("four point five")).toEqual(["4.5"]);
    expect(numberForms("fifty-one point five")).toEqual(["51.5"]);
  });

  it("reads a and an as one only before a scale word", () => {
    // Catches: "a five" read as the pair 1 and 5, which made "a five-hour ceiling" 105.
    expect(numberForms("a five")).toEqual(["5"]);
    expect(numberForms("an eight")).toEqual(["8"]);
    expect(numberForms("a thousand")).toEqual(["1000"]);
    expect(numberForms("a million")).toEqual(["1000000"]);
  });

  it("reads two numbers side by side as a year only when both are ten or more", () => {
    expect(numberForms("nineteen ninety")).toEqual(["1990"]);
    expect(numberForms("twenty twenty-six")).toEqual(["2026"]);
    expect(numberForms("nineteen oh five")).toEqual(["1905"]);
    expect(numberForms("one two")).toEqual(["1", "2"]);
    expect(numberForms("five and ten percent")).toEqual(["5", "10%"]);
  });

  it("reads digits with a unit tag as the number", () => {
    expect(numberForms("5 s")).toEqual(["5"]);
    expect(numberForms("9 ms")).toEqual(["9"]);
    expect(numberForms("3x")).toEqual(["3"]);
    expect(numberForms("5k")).toEqual(["5000"]);
  });

  it("keeps text it cannot read as written, lower-cased", () => {
    expect(numberForms("a dozen")).toEqual(["a dozen"]);
    expect(numberForms("Twelve trillion")).toEqual(["twelve trillion"]);
  });
});
