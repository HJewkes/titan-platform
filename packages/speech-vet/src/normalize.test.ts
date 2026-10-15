import { describe, expect, it } from "vitest";
import conformance from "../conformance/normalize.json" with { type: "json" };
import {
  DEFAULT_NORMALIZE_STEPS,
  NUMBER_STEPS,
  normalize,
  rateStep,
  RATE_UNITS,
  timeStep,
  type NormalizeStep,
} from "./normalize.js";
import { numberToOrdinal, numberToWords } from "./number-words.js";

const numbers = (text: string): string => normalize(text, NUMBER_STEPS);

// Ported from the audiobook test_normalizer.py TestCurrencyNormalization cases.
describe("currency", () => {
  // Catches: the magnitude word placed after the currency word, giving "one point four pounds million".
  it("decimal million suffix", () => {
    expect(numbers("£1.4m")).toBe("one point four million pounds");
  });

  // Catches: the k suffix not mapped to "thousand".
  it("thousand suffix", () => {
    expect(numbers("£900k")).toBe("nine hundred thousand pounds");
  });

  // Catches: a spelled-out magnitude after a space left out of the amount, giving "two pounds million".
  it("spelled out million word", () => {
    expect(numbers("£2 million")).toBe("two million pounds");
  });

  // Catches: thousands commas kept, so only "50" is read as the amount.
  it("plain thousands with comma", () => {
    expect(numbers("£50,000")).toBe("fifty thousand pounds");
  });

  // Catches: a multi-digit fraction read digit by digit ("zero point one seven six million").
  it("multidigit fraction multiplied out not read digit by digit", () => {
    expect(numbers("£0.176m")).toBe("one hundred seventy-six thousand pounds");
  });

  // Catches: the multiply-out limited to three-digit fractions.
  it("two digit fraction suffix multiplied out", () => {
    expect(numbers("£0.28m")).toBe("two hundred eighty thousand pounds");
  });

  // Catches: number words capped below a million.
  it("multimillion with commas", () => {
    expect(numbers("£4,163,432")).toBe("four million one hundred sixty-three thousand four hundred thirty-two pounds");
  });

  // Catches: only the pound sign mapped to a currency word.
  it("dollars and euros", () => {
    expect([numbers("$5.24m"), numbers("€3k")]).toEqual(["five million two hundred forty thousand dollars", "three thousand euros"]);
  });

  // Catches: single-digit fractions multiplied out too, giving "one million four hundred thousand pounds".
  it("single digit fraction stays point form", () => {
    expect(numbers("£1.4m")).toBe("one point four million pounds");
  });
});

// Ported from TestNumberWordsScale.
describe("number words scale", () => {
  // Catches: the million scale missing, so 4000000 reads "four thousand thousand".
  it("millions", () => {
    expect(numberToWords(4_000_000)).toBe("four million");
  });

  // Catches: the billion scale missing.
  it("billions", () => {
    expect(numberToWords(2_000_000_000)).toBe("two billion");
  });
});

// Ported from TestProgressionAndSlashAndAsterisk; the arrow, compound-slash and asterisk cases are policy.
describe("rates", () => {
  // Catches: the slash before a rate unit left in place, so the voice says "slash week".
  it("slash week becomes per week", () => {
    expect(normalize("£9,800/week", [rateStep()])).toBe("£9,800 per week");
  });

  // Catches: the caller's units ignored, so a domain cannot add "match".
  it("a caller adds its own rate units", () => {
    expect(normalize("£40/match", [rateStep([...RATE_UNITS, "match"])])).toBe("£40 per match");
  });
});

// Ported from TestDecimalNormalization.
describe("decimals", () => {
  // Catches: decimals skipped, so the cardinal rule gives "one hundred forty-seven.8".
  it("decimal over one hundred", () => {
    expect(numbers("147.8")).toBe("one hundred forty-seven point eight");
  });

  // Catches: the decimal rule anchored to the whole string.
  it("decimal in sentence", () => {
    expect(numbers("We were 147.8 but we played worse")).toBe("We were one hundred forty-seven point eight but we played worse");
  });

  // Catches: decimals skipped, so "3.5" is left as digits.
  it("small decimal", () => {
    expect(numbers("3.5")).toBe("three point five");
  });

  // Catches: the magnitude suffix dropped from non-currency decimals.
  it("decimal with magnitude suffix", () => {
    expect([numbers("3.1m"), numbers("0.28m")]).toEqual(["three point one million", "two hundred eighty thousand"]);
  });

  // Catches: the percent sign consumed or spoken; the original leaves it for the voice.
  it("percentage decimal keeps percent", () => {
    expect(numbers("1.39%")).toBe("one point three nine%");
  });

  // Catches: decimals run before currency, so "£1.4m" is split into "£one point four million".
  it("currency decimal still correct", () => {
    expect(numbers("£1.4m")).toBe("one point four million pounds");
  });
});

// Mechanism rules normalizer.py has no test for.
describe("ordinals, ages, times and cardinals", () => {
  // Catches: the original's "y to ieth, else th" rule, which reads 42nd as "forty-twoth".
  it.each([
    [1, "first"], [12, "twelfth"], [20, "twentieth"], [21, "twenty-first"], [42, "forty-second"], [99, "ninety-ninth"],
  ])("ordinal of %i", (n, expected) => {
    expect(numberToOrdinal(n)).toBe(expected);
  });

  // Catches: the ordinal suffix kept after the words, or the age left as digits.
  it("expands ordinals and ages", () => {
    expect(numbers("the 3rd of 4, a 15-year-old")).toBe("the third of 4, a fifteen-year-old");
  });

  // Catches: small numbers expanded too, or a leading-zero code read as a number.
  it("leaves numbers under one hundred as digits", () => {
    expect(numbers("42 of 007 and 100")).toBe("42 of 007 and one hundred");
  });

  // Catches: a word that starts with am or pm read as a clock time, giving "five A M azing".
  it.each([
    ["at 7 pm", "at seven P M"],
    ["at 10 a.m. sharp", "at ten A M sharp"],
    ["a 5 amazing goals", "a 5 amazing goals"],
  ])("clock time: %s", (text, expected) => {
    expect(normalize(text, [timeStep])).toBe(expected);
  });
});

describe("normalize", () => {
  // Catches: the default list missing the number, rate, initialism or whitespace step.
  it("runs the default steps end to end", () => {
    expect(normalize("  The CEO earns £9,800/week   at 3.5  times\n\n\n\nthe rate.  ")).toBe(
      "The C. E. O. earns nine thousand eight hundred pounds per week at three point five times\n\nthe rate.",
    );
  });

  // Catches: the steps argument ignored, or steps run out of order.
  it("runs only the caller's steps, in the caller's order", () => {
    const shout: NormalizeStep = { name: "shout", apply: (text) => text.toUpperCase() };
    const withoutInitialisms = DEFAULT_NORMALIZE_STEPS.filter((step) => step.name !== "initialisms");

    expect([normalize("the ceo", [shout]), normalize("the BBC", withoutInitialisms)]).toEqual(["THE CEO", "the BBC"]);
  });

  // Catches: conformance/normalize.json drifting from the code that AB's pytest checks against.
  it.each(conformance.cases)("conformance: $name", ({ steps, input, expected }) => {
    const byName = new Map(DEFAULT_NORMALIZE_STEPS.map((step) => [step.name, step]));
    const picked = steps.map((name) => byName.get(name)).filter((step) => step !== undefined);

    expect(picked).toHaveLength(steps.length);
    expect(normalize(input, picked)).toBe(expected);
  });
});
