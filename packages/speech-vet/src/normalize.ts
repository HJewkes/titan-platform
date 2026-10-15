/**
 * Text normalization for narration: the general-purpose expansions any voice needs before it reads a text.
 *
 * Each step is one rewrite, and `normalize` runs a list of them in order. The default list is the mechanism half
 * of the audiobook normalizer: rates ("/week" to " per week"), initialisms, clock times, ages, ordinals, currency,
 * decimals, large cardinals and whitespace. A product's own rules (book preambles, house punctuation, its
 * lexicon) are steps it writes and splices into the list.
 *
 * Order matters inside the number steps: currency runs before decimals, so "£1.4m" is read as one amount, and
 * decimals run before cardinals, so "147.8" is not split into "one hundred forty-seven.8". Numbers under 100 are
 * left as digits, which voices read well.
 */
import { spellInitialisms, type InitialismOptions } from "./initialisms.js";
import { numberToOrdinal, numberToWords, spellDigits } from "./number-words.js";

export interface NormalizeStep {
  readonly name: string;
  readonly apply: (text: string) => string;
}

const MAGNITUDES: Readonly<Record<string, bigint>> = {
  k: 1_000n, thousand: 1_000n,
  m: 1_000_000n, million: 1_000_000n,
  bn: 1_000_000_000n, billion: 1_000_000_000n,
};
const MAGNITUDE_WORDS: Readonly<Record<string, string>> = {
  k: "thousand", thousand: "thousand", m: "million", million: "million", bn: "billion", billion: "billion",
};
const CURRENCY_NAMES: Readonly<Record<string, string>> = { "£": "pounds", $: "dollars", "€": "euros" };

/** Rate units a slash reads as "per"; a domain adds its own ("match", "game") through `rateStep`. */
export const RATE_UNITS: readonly string[] = ["day", "week", "month", "year"];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cardinal(digits: string): string {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? numberToWords(n) : digits;
}

/**
 * A multi-digit fraction with a magnitude is multiplied out to an exact integer, because voices slur digit runs
 * ("one seven six" heard as "seventeen six"): "0.176m" is "one hundred seventy-six thousand". A single-digit
 * fraction reads well as "point four" and stays.
 */
function multipliedOut(intPart: string, fraction: string, multiplier: bigint | undefined): string | undefined {
  if (!multiplier || fraction.length < 2) return undefined;
  const pow10 = 10n ** BigInt(fraction.length);
  const scaledFraction = BigInt(fraction) * multiplier;
  if (scaledFraction % pow10 !== 0n) return undefined;
  return cardinal(String(BigInt(intPart) * multiplier + scaledFraction / pow10));
}

/** An amount's words with the magnitude last: ("1", "4", "m") is "one point four million". */
function amountWords(intPart: string, fraction: string | undefined, magnitude: string | undefined): string {
  const suffix = (magnitude ?? "").toLowerCase();
  if (fraction) {
    const exact = multipliedOut(intPart, fraction, MAGNITUDES[suffix]);
    if (exact !== undefined) return exact;
  }
  const words = fraction ? `${cardinal(intPart)} point ${spellDigits(fraction)}` : cardinal(intPart);
  const magnitudeWord = MAGNITUDE_WORDS[suffix];
  return magnitudeWord ? `${words} ${magnitudeWord}` : words;
}

/** "/week" reads as " per week"; any other slash is left to the caller's policy. */
export function rateStep(units: Iterable<string> = RATE_UNITS): NormalizeStep {
  const pattern = new RegExp(`/\\s*(${[...units].map(escapeRegExp).join("|")})\\b`, "gi");
  return { name: "rates", apply: (text) => text.replace(pattern, " per $1") };
}

/** Dotted letters for all-caps initialisms, through {@link spellInitialisms}. */
export function initialismStep(opts: InitialismOptions = {}): NormalizeStep {
  return { name: "initialisms", apply: (text) => spellInitialisms(text, opts) };
}

const CLOCK_TIME = /\b(\d+)\s+(a\.m\.|p\.m\.|am|pm)(?![a-z])/gi;

/** "7 pm" and "7 p.m." read as "seven P M". */
export const timeStep: NormalizeStep = {
  name: "times",
  apply: (text) =>
    text.replace(CLOCK_TIME, (_match, hour: string, period: string) => {
      const [first, second] = period.replace(/\./g, "").toUpperCase();
      return `${cardinal(hour)} ${first} ${second}`;
    }),
};

/** "15-year-old" reads as "fifteen-year-old". */
export const ageStep: NormalizeStep = {
  name: "ages",
  apply: (text) => text.replace(/(\d+)-year-old/g, (_match, age: string) => `${cardinal(age)}-year-old`),
};

/** "21st" reads as "twenty-first"; only one- and two-digit ordinals are expanded. */
export const ordinalStep: NormalizeStep = {
  name: "ordinals",
  apply: (text) => text.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/g, (_match, n: string) => numberToOrdinal(Number(n))),
};

const CURRENCY_AMOUNT = /([£$€])\s?(\d+(?:,\d{3})*)(?:\.(\d+))?(?:\s*(k|m|bn|thousand|million|billion))?\b/g;

/** "£1.4m" reads as "one point four million pounds", with the currency word last. */
export const currencyStep: NormalizeStep = {
  name: "currency",
  apply: (text) =>
    text.replace(CURRENCY_AMOUNT, (_match, symbol: string, amount: string, fraction?: string, magnitude?: string) =>
      `${amountWords(amount.replace(/,/g, ""), fraction, magnitude)} ${CURRENCY_NAMES[symbol] ?? "units"}`,
    ),
};

/** "147.8" reads as "one hundred forty-seven point eight", and "0.28m" as "two hundred eighty thousand". */
export const decimalStep: NormalizeStep = {
  name: "decimals",
  apply: (text) =>
    text.replace(/\b(\d+)\.(\d+)(k|m|bn)?\b/g, (_match, intPart: string, fraction: string, magnitude?: string) =>
      amountWords(intPart, fraction, magnitude),
    ),
};

function largeCardinal(match: string): string {
  const digits = match.replace(/,/g, "");
  return Number(digits) >= 100 ? cardinal(digits) : match;
}

/** Comma-grouped numbers and numbers of 100 or more read as words; "007" and "42" stay digits. */
export const cardinalStep: NormalizeStep = {
  name: "cardinals",
  apply: (text) => text.replace(/\b\d{1,3}(?:,\d{3})+\b/g, largeCardinal).replace(/\b\d{3,}\b/g, largeCardinal),
};

/** Tabs and runs of spaces become one space, three or more newlines a paragraph break, and the ends are trimmed. */
export const whitespaceStep: NormalizeStep = {
  name: "whitespace",
  apply: (text) => text.replace(/\t/g, " ").replace(/ +/g, " ").replace(/\n{3,}/g, "\n\n").trim(),
};

/** The audiobook normalizer's `normalize_numbers`, in its order. */
export const NUMBER_STEPS: readonly NormalizeStep[] = [ageStep, ordinalStep, currencyStep, decimalStep, cardinalStep];

export const DEFAULT_NORMALIZE_STEPS: readonly NormalizeStep[] = [
  rateStep(),
  initialismStep(),
  timeStep,
  ...NUMBER_STEPS,
  whitespaceStep,
];

/** Runs `steps` over `text` in order; a caller filters or splices the default list to pick its own. */
export function normalize(text: string, steps: readonly NormalizeStep[] = DEFAULT_NORMALIZE_STEPS): string {
  return steps.reduce((current, step) => step.apply(current), text);
}
