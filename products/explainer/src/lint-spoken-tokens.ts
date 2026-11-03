import { readFileSync } from "node:fs";
import { join } from "node:path";
import { g2pText, loadLexicon, SHOUTED_TWO_LETTER_WORDS, type Lexicon } from "@titan-design/speech-vet";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import type { L0Check, L0Result } from "./eval-l0.js";
import { countRow } from "./lint-text.js";
import { clipped, namedBeats } from "./repair-hint.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import { spellSpokenNumbers } from "./spoken-numbers.js";

export type SpokenTokenKind = "abbreviation" | "path" | "code" | "unit" | "acronym" | "symbol";

export interface SpokenToken {
  kind: SpokenTokenKind;
  text: string;
}

// Print devices and written-only tokens a voice misreads (PL-32, PL-21, XT-13). Each kind blanks what it matched
// before the next runs, so "e.g." is an abbreviation and never also a dotted path, and "index.ts" never a symbol.
const TOKEN_PATTERNS: readonly (readonly [SpokenTokenKind, RegExp])[] = [
  ["abbreviation", /\b(?:e\.g|i\.e|etc|vs|approx)\.|\bvs\b/gi],
  ["path", /[\w.~-]*\/(?:[\w./-]*[\w/])?|\b[\w-]*[A-Za-z][\w-]*(?:\.[\w-]+)+\b/g],
  ["code", /(?<![\w-])--[a-z][\w-]*|\b\w+\(\)|`[^`]*`|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b\w+_\w+\b/g],
  ["unit", /\b(?:ms|ns|µs|px|fps|rpm|kb|mb|gb|tb|km|kg|hz|khz|ghz)\b/gi],
  ["acronym", /\b[A-Z]{2,}s?\b(?!['’])/g],
  ["symbol", /[%&/\\|@#<>=+*~^_{}[\]()$`]/g],
];

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LINK = /\[[^\]]+\]\([^)]*\)/g;

// A `[w](/phonemes/)` override and a lexicon term are spoken aliases; a `[w](=reading)` declaration is not, so its word stays.
function withoutAliases(spoken: string, lexicon: Lexicon): string {
  const bare = g2pText(spoken).replace(LINK, " ");
  return lexicon.entries.reduce((text, { term }) => text.replace(new RegExp(`(?<![\\w])${escaped(term)}(?![\\w])`, "gi"), " "), bare);
}

const isShoutedWord = (kind: SpokenTokenKind, text: string): boolean => kind === "acronym" && SHOUTED_TWO_LETTER_WORDS.has(text.replace(/s$/, ""));

/** Each print device or written-only token in a spoken line that neither the lexicon nor an inline phoneme override voices. */
export function unaliasedTokens(spoken: string, lexicon: Lexicon = { schema: "lexicon.v1", entries: [] }): SpokenToken[] {
  let rest = withoutAliases(spoken, lexicon);
  const found: SpokenToken[] = [];
  for (const [kind, pattern] of TOKEN_PATTERNS) {
    for (const [text] of rest.matchAll(pattern)) if (!isShoutedWord(kind, text)) found.push({ kind, text });
    rest = rest.replace(pattern, " ");
  }
  return found;
}

let shipped: Lexicon | undefined;
const shippedLexicon = (): Lexicon => (shipped ??= loadLexicon(JSON.parse(readFileSync(join(DEFAULT_DOCTRINE_DIR, "lexicon.json"), "utf8"))));

const tokenBeats = (beats: readonly ScriptBeat[], lexicon: Lexicon): string[] =>
  beats.filter((beat) => unaliasedTokens(beat.spoken, lexicon).length > 0).map((beat) => beat.id);

/** Q-V14: a spoken line carries no print device, and every path, code token, unit or acronym in it has a spoken alias. */
export function spokenTokenCheckWith(lexicon?: Lexicon): L0Check {
  return ({ script }) => [countRow("Q-V14", tokenBeats(script.beats, lexicon ?? shippedLexicon()))];
}

export const spokenTokenCheck: L0Check = spokenTokenCheckWith();

/** The Q-V14 repair: each unvoiced token with its kind, and the two ways to give it a voice. */
export function spokenTokenHint(script: ScriptV1, row: L0Result): string {
  const named = namedBeats(script, row).map((beat) => {
    const tokens = unaliasedTokens(beat.spoken, shippedLexicon()).map(({ kind, text }) => `"${text}" (${kind})`);
    return `${beat.id} ${tokens.join(", ")}`;
  });
  return `written-only tokens in spoken: ${named.join("; ")}. Say each in words ("for example", "percent", "and", "or", "milliseconds"), drop the parentheses, or give a path, code token or acronym a lexicon entry or a [word](/phonemes/) override`;
}

/** The Q-V12 repair: each line with digits, as it reads with its numbers spelled. */
export function spokenDigitsHint(script: ScriptV1, row: L0Result): string {
  const lines = namedBeats(script, row).map((beat) => `${beat.id} "${clipped(spellSpokenNumbers(beat).spoken)}"`);
  return `spoken lines hold digits; say each number in words, for example ${lines.join("; ")}`;
}
