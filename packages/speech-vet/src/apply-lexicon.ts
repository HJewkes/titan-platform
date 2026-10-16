import type { Lexicon } from "./lexicon.js";
import { respellingsOf } from "./lexicon.js";
import { plainText, splitLinks } from "./markup.js";
import { respeller, wholeWords } from "./respell.js";

function misakiOverrides(lexicon: Lexicon): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const { term, phonemes } of lexicon.entries) {
    if (phonemes?.misaki !== undefined) overrides.set(term.toLowerCase(), phonemes.misaki);
  }
  return overrides;
}

function wrapOverrides(spoken: string, overrides: ReadonlyMap<string, string>): string {
  const pattern = wholeWords([...overrides.keys()]);
  if (pattern === null) return spoken;
  return splitLinks(spoken)
    .map(({ kind, text }) =>
      kind === "link" ? text : text.replace(pattern, (word) => `[${word}](/${overrides.get(word.toLowerCase()) ?? ""}/)`),
    )
    .join("");
}

/**
 * Applies the lexicon's pronunciation levers to a spoken line, for the voice that will say it.
 *
 * `"misaki"` wraps each whole-term occurrence of a `phonemes.misaki` entry as `[word](/phonemes/)`, keeping the
 * original casing and leaving occurrences already inside a link alone. `"text"` strips the markup and applies the
 * `respell` entries. `spoken` rewrites are ignored because they change captions, which the caller applies itself, and
 * `phonemes.ipa` is espeak intent that no vet voice takes as input.
 */
export function applyLexicon(spoken: string, lexicon: Lexicon, alphabet: "misaki" | "text"): string {
  if (alphabet === "text") return respeller(respellingsOf(lexicon)).apply(plainText(spoken));
  return wrapOverrides(spoken, misakiOverrides(lexicon));
}
