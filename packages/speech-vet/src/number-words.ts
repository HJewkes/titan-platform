const ONES = [
  "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: readonly (readonly [number, string])[] = [
  [1e9, "billion"],
  [1e6, "million"],
  [1e3, "thousand"],
  [100, "hundred"],
];
/** Every word {@link numberToWords} can produce, so a reader can find spoken numbers in text. */
export const NUMBER_WORDS: ReadonlySet<string> = new Set(
  ["zero", ...ONES, ...TENS, ...SCALES.map(([, word]) => word)].filter(Boolean),
);
const IRREGULAR_ORDINALS: Readonly<Record<string, string>> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};

/**
 * American cardinal words, with no "and": 147 is "one hundred forty-seven". From a trillion up the digits are
 * returned unchanged, as the audiobook original does.
 */
export function numberToWords(n: number): string {
  if (n === 0) return "zero";
  if (n >= 1e12) return String(n);
  if (n < 20) return ONES[n] ?? String(n);
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  const [scale, word] = SCALES.find(([size]) => n >= size) ?? [100, "hundred"];
  const remainder = n % scale;
  const head = `${numberToWords(Math.floor(n / scale))} ${word}`;
  return remainder ? `${head} ${numberToWords(remainder)}` : head;
}

/** Ordinal words: 21 is "twenty-first", 42 is "forty-second". */
export function numberToOrdinal(n: number): string {
  const words = numberToWords(n);
  const last = /[a-z]+$/.exec(words)?.[0];
  if (last === undefined) return words;
  const stem = words.slice(0, words.length - last.length);
  const irregular = IRREGULAR_ORDINALS[last];
  if (irregular) return stem + irregular;
  return stem + (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
}

/** A decimal fraction read digit by digit: "176" is "one seven six". */
export function spellDigits(digits: string): string {
  return [...digits].map((d) => numberToWords(Number(d))).join(" ");
}
