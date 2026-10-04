import type { WordToken } from "./lexer.js";

/** Every long option of findutils xargs; getopt_long also takes any unambiguous prefix of one. */
const XARGS_LONG = [
  "null", "arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "open-tty", "interactive",
  "no-run-if-empty", "max-chars", "verbose", "show-limits", "exit", "max-procs", "process-slot-var", "version", "help",
];

/** The long option `v` abbreviates, spelled out with any `=value` kept; null when the prefix fits several. */
function fullXargsOption(v: string): string | null {
  const eq = v.indexOf("=");
  const name = v.slice(2, eq < 0 ? undefined : eq);
  if (XARGS_LONG.includes(name)) return v;
  const matches = XARGS_LONG.filter((o) => o.startsWith(name));
  if (matches.length > 1) return null;
  return matches.length === 1 ? `--${matches[0]}${eq < 0 ? "" : v.slice(eq)}` : v;
}

/** The words with each xargs long option from `start` on spelled out, or the index of an ambiguous one. */
export function spellXargsOptions(words: WordToken[], start: number, takesValue: (v: string) => boolean): WordToken[] | number {
  const out = [...words];
  for (let j = start; j < out.length && (out[j] as WordToken).value.startsWith("-") && (out[j] as WordToken).value !== "--"; j++) {
    const word = out[j] as WordToken;
    const full = word.value.startsWith("--") && !word.dynamic ? fullXargsOption(word.value) : word.value;
    if (full === null) return j;
    out[j] = { ...word, value: full };
    if (takesValue(full)) j++;
  }
  return out;
}
