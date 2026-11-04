import { SequenceMatcher } from "@titan-design/speech-stt";
import { HOMOPHONES } from "../lexicon.js";
import type { TimedWord } from "./tts-truing.js";

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const norm = (word: string): string => word.toLowerCase().replace(/[^a-z0-9%]/g, "");

/** `thirteen` → `13`, `fortyfive` → `45`: the speaker says the word, the tokenizer may write digits. */
function asDigits(token: string): string | undefined {
  const unit = UNITS.indexOf(token);
  if (unit >= 0) return String(unit);
  const tens = TENS.findIndex((t) => t !== "" && token.startsWith(t));
  if (tens < 0) return undefined;
  const rest = token.slice(TENS[tens]!.length);
  if (rest === "") return String(tens * 10);
  const ones = UNITS.indexOf(rest);
  return ones >= 1 && ones <= 9 ? String(tens * 10 + ones) : undefined;
}

/** (token, script word index): a number word becomes digits, and any other hyphenated word yields one token per part. */
function scriptTokens(words: readonly string[]): [string, number][] {
  return words.flatMap((word, i): [string, number][] => {
    const digits = asDigits(norm(word));
    if (digits !== undefined) return [[digits, i]];
    if (!word.includes("-")) return [[norm(word), i]];
    return word.split("-").map(norm).filter(Boolean).map((part): [string, number] => [part, i]);
  });
}

function heardToken(word: string, homophones: Readonly<Record<string, string>>): string {
  const n = norm(word);
  return asDigits(n) ?? homophones[n] ?? n;
}

type Span = [number, number];

function matchedSpans(script: readonly string[], heard: readonly TimedWord[], homophones: Readonly<Record<string, string>>): Map<number, Span> {
  const tokens = scriptTokens(script);
  const matcher = new SequenceMatcher(tokens.map(([t]) => t), heard.map((h) => heardToken(h.word, homophones)), { autojunk: false });
  const spans = new Map<number, Span>();
  for (const block of matcher.matchingBlocks()) {
    for (let k = 0; k < block.size; k++) {
      const i = tokens[block.a + k]![1];
      const h = heard[block.b + k]!;
      const [s, e] = spans.get(i) ?? [h.start, h.end];
      spans.set(i, [Math.min(s, h.start), Math.max(e, h.end)]);
    }
  }
  return spans;
}

const millis = (s: number): number => Math.round(s * 1000) / 1000;

/**
 * Times every script word from the words the engine reports (the port of `realign.py`). Both sides go to one
 * canonical form first (number words as digits, hyphenated words as parts, homophones as the script word), so a
 * word the engine spells differently still anchors its own time. A run of unmatched words shares the gap between its
 * neighbours evenly; the first heard start and the last heard end anchor the two ends.
 */
export function realign(script: readonly string[], heard: readonly TimedWord[], homophones: Readonly<Record<string, string>> = HOMOPHONES): TimedWord[] {
  if (heard.length === 0) throw new Error("realign needs at least one heard word to anchor the script");
  const spans = matchedSpans(script, heard, homophones);
  const first = heard[0]!.start;
  const last = heard.at(-1)!.end;
  const edges: (Span | undefined)[] = [[first, first], ...script.map((_, i) => spans.get(i)), [last, last]];
  for (let i = 1; i < edges.length - 1; ) {
    if (edges[i]) {
      i++;
      continue;
    }
    let j = i;
    while (!edges[j]) j++;
    const t0 = edges[i - 1]![1];
    const step = (edges[j]![0] - t0) / (j - i);
    for (let k = i; k < j; k++) edges[k] = [t0 + step * (k - i), t0 + step * (k - i + 1)];
    i = j;
  }
  return script.map((word, k) => ({ word, start: millis(edges[k + 1]![0]), end: millis(edges[k + 1]![1]) }));
}
