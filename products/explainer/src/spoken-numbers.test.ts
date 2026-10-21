import { describe, expect, it } from "vitest";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { hasSpokenDigits, spellSpokenNumbers, spokenDigitsCheck } from "./spoken-numbers.js";
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

  it("spells percent, ordinals and decimals", () => {
    expect(spell("Half of the 2nd batch, 3.5 percent or 40% of it.")).toBe(
      "Half of the second batch, three point five percent or forty percent of it.",
    );
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
    expect(rowFor("The desk keeps 3 scans.")).toMatchObject([{ check_id: "Q-V12", severity: "warning", pass: false, detail_beats: ["c2-1-stations"] }]);
  });

  it("passes a spelled beat and one whose only digits sit in markup", () => {
    expect(rowFor("The desk keeps three scans.")[0]).toMatchObject({ pass: true });
    expect(hasSpokenDigits("The [desk 7](=queue) is fine.")).toBe(false);
  });
});
