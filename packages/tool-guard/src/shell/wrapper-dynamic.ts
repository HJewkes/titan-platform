import { takesNextWord } from "./cluster.js";
import type { WordToken } from "./lexer.js";

interface OptionSpec {
  values?: string[];
  stop?: string[];
  optional?: string[];
  digits?: boolean;
}

/** More dynamic words than this stay read as today: each one triples the readings. */
const MAX_DYNAMIC = 4;

/**
 * Index of the first dynamic word that sits where a wrapper option could be, or -1. A word such as `-$O` counts
 * too: its dash is known but the option letters are not.
 */
function dynamicOptionAt(words: WordToken[], start: number, spec: OptionSpec): number {
  for (let i = start; i < words.length; ) {
    const w = words[i] as WordToken;
    if (w.dynamic && (!w.value.startsWith("-") || w.refs.every((r) => r.start <= leadingDashes(w.value)))) return i;
    if (!w.value.startsWith("-") || w.value === "--" || spec.stop?.includes(w.value)) return -1;
    i += takesNextWord(w.value, spec) ? 2 : 1;
  }
  return -1;
}

function leadingDashes(value: string): number {
  return value.length - value.replace(/^-+/, "").length;
}

function quoteWord(w: WordToken): string {
  if (w.dynamic) return `"${w.value.replace(/["\\`]/g, "\\$&")}"`;
  return `'${w.value.replaceAll("'", "'\\''")}'`;
}

/**
 * Shell text that reads a dynamic word in a wrapper's option position every way it could expand: to nothing or to
 * an option without a value (the word is gone), to an option that takes the next word (both are gone), or to
 * a positional (a literal stands in). An `xargs` option word may also be `-I`, which makes the next word its replace
 * string; a bare dynamic `xargs` word is its dynamic command, which the xargs reading already fails closed on.
 * Null when the wrapper's options hold no dynamic word, or hold too many to read in full.
 */
export function dynamicOptionReadings(words: WordToken[], at: number, start: number, spec: OptionSpec): string | null {
  const d = dynamicOptionAt(words, start, spec);
  if (d < 0 || words.filter((w) => w.dynamic).length > MAX_DYNAMIC) return null;
  const dashed = (words[d] as WordToken).value.startsWith("-");
  const xargs = /(^|\/)xargs$/.test((words[at] as WordToken).value);
  if (xargs && !dashed) return null;
  const before = words.slice(at, d).map(quoteWord);
  const after = words.slice(d + 1).map(quoteWord);
  const readings = [after, after.slice(1)];
  if (!dashed) readings.push(["0", ...after]);
  if (xargs) readings.push(["-I", ...after]);
  return readings.map((rest) => [...before, ...rest].join(" ")).join("\n");
}
