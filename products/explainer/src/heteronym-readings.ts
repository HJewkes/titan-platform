import { numberToWords } from "@titan-design/speech-vet";
import type { ScriptV1 } from "./script-schema.js";

// The words the number speller writes, so a count it spelled ("eighteen point eight three") reads as a numeral.
const NUMBER_WORDS: ReadonlySet<string> = new Set(
  [...Array.from({ length: 100 }, (_, n) => n), 100, 1e3, 1e6, 1e9].flatMap((n) => numberToWords(n).split(/[\s-]/)),
);

// A link is one token, so a word already declared or overridden is never declared again.
const TOKEN = /\[[^\]]+\]\([^)]*\)|[A-Za-z0-9]+(?:'[A-Za-z]+)*/g;
const COUNTED_MINUTE = /^minutes?$/i;

const isNumeral = (token: string): boolean => /^\d+$/.test(token) || NUMBER_WORDS.has(token.toLowerCase());

/** Whether only a space separates two tokens, so the numeral counts the minute rather than ending a phrase before it. */
const adjacent = (spoken: string, end: number, start: number): boolean => /^\s+$/.test(spoken.slice(end, start));

/**
 * The line with `[minute(s)](=time)` on each bare "minute" or "minutes" a numeral directly counts. That is the one
 * reading the words around a heteronym settle without the sentence's meaning; every other one stays bare, so Q-V10
 * names it and the L0 repair declares it.
 */
export function declareReadings(spoken: string): string {
  const tokens = [...spoken.matchAll(TOKEN)];
  let out = "";
  let last = 0;
  tokens.forEach((token, i) => {
    const before = tokens[i - 1];
    if (!COUNTED_MINUTE.test(token[0]) || before === undefined || !isNumeral(before[0])) return;
    if (!adjacent(spoken, before.index + before[0].length, token.index)) return;
    out += `${spoken.slice(last, token.index)}[${token[0]}](=time)`;
    last = token.index + token[0].length;
  });
  return out + spoken.slice(last);
}

/** Every beat's spoken line with each counted minute declared. */
export const declareScriptReadings = (script: ScriptV1): ScriptV1 => ({
  ...script,
  beats: script.beats.map((beat) => ({ ...beat, spoken: declareReadings(beat.spoken) })),
});
