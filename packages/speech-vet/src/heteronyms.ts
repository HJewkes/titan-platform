import { z } from "zod";
import enJson from "./heteronyms/en.json" with { type: "json" };
import { countOccurrences, markupTargets, occurrenceKey, plainText } from "./markup.js";
import { escapeRegExp } from "./regexp.js";

const STRESS = /[ˈˌ]/g;

/**
 * Per word, its readings in order, each a phoneme pattern matched at the start of the stress-stripped token phonemes
 * (misaki notation: I=aɪ, A=eɪ, O=oʊ, W=aʊ, Y=ɔɪ), and the spellings checked. Inflections that are not heteronyms are left out.
 */
export const HeteronymTableSchema = z.object({
  version: z.number().int().positive(),
  notation: z.literal("misaki"),
  words: z.record(
    z.string().min(1),
    z.object({
      readings: z.record(z.string().min(1), z.string().min(1)).refine((readings) => Object.keys(readings).length >= 2),
      forms: z.array(z.string().min(1)).min(1),
    }),
  ),
});
export type HeteronymTable = z.infer<typeof HeteronymTableSchema>;

/** The 19-word English table, in misaki notation. */
export const englishHeteronyms: HeteronymTable = HeteronymTableSchema.parse(enJson);

/** The token fields the check reads; a speech-g2p `G2pToken` satisfies it. */
export interface PhonemeToken {
  text: string;
  phonemes: string | null;
  whitespace: string;
}

/**
 * `ok` and `fail` judge a `[w](=reading)` declaration, `forced` marks a `[w](/phonemes/)` override,
 * and `warn` is an undeclared occurrence.
 */
export type ReadingStatus = "ok" | "fail" | "forced" | "warn";

export interface ReadingFinding {
  word: string;
  /** One-based ordinal among the occurrences of this spelling in the line. */
  occurrence: number;
  phonemes: string | null;
  /** The reading the phonemes match, or `unknown`. */
  reading: string;
  declared: string | null;
  status: ReadingStatus;
}

/** The name of the first reading of `word` whose pattern matches the phonemes, or `unknown`. */
export function readingOf(word: string, phonemes: string | null, table: HeteronymTable = englishHeteronyms): string {
  const bare = (phonemes ?? "").replace(STRESS, "");
  const readings = Object.entries(table.words[word]?.readings ?? {});
  return readings.find(([, pattern]) => new RegExp(`^(?:${pattern})`, "u").test(bare))?.[0] ?? "unknown";
}

function formsOf(table: HeteronymTable): Map<string, string> {
  return new Map(Object.entries(table.words).flatMap(([word, { forms }]) => forms.map((form) => [form, word] as const)));
}

function statusOf(reading: string, target: string): { declared: string | null; status: ReadingStatus } {
  const declared = target.startsWith("=") ? target.slice(1) : "";
  if (declared) return { declared, status: reading === declared ? "ok" : "fail" };
  return { declared: null, status: target.startsWith("/") ? "forced" : "warn" };
}

/** A heteronym occurrence's finding, with the table word it belongs to and its index among the tokens. */
export interface HeteronymOccurrence {
  tokenIndex: number;
  tableWord: string;
  finding: ReadingFinding;
}

const POSSESSIVE_TOKEN = /^(.+?)'s?$/;
const DECLARATION = /\[([^\]]+)\]\(([^)]*)\)('s?(?![A-Za-z']))?/g;

/** A `[w](=reading)` declaration, keyed apart from the plain spelling when an apostrophe suffix follows it. */
interface Declaration {
  key: string;
  word: string;
  ordinal: number;
  declared: string;
}

function declarationKey(form: string, possessive: boolean, ordinal: number): string {
  return occurrenceKey(possessive ? `${form}'` : form, ordinal);
}

function countPossessives(text: string, form: string): number {
  return text.match(new RegExp(`(?<![A-Za-z'])${escapeRegExp(form)}'s?(?![A-Za-z'])`, "gi"))?.length ?? 0;
}

function declarationsOf(spoken: string): Declaration[] {
  const declarations: Declaration[] = [];
  let plain = "";
  let last = 0;
  for (const match of spoken.matchAll(DECLARATION)) {
    const [link, word = "", target = "", suffix] = match;
    plain += plainText(spoken.slice(last, match.index));
    const form = word.toLowerCase();
    const possessive = suffix !== undefined;
    const ordinal = possessive ? countPossessives(plain, form) : countOccurrences(plain, form);
    if (target.startsWith("=")) declarations.push({ key: declarationKey(form, possessive, ordinal), word, ordinal, declared: target.slice(1) });
    plain += word;
    last = match.index + link.length - (suffix?.length ?? 0);
  }
  return declarations;
}

/** The spelling a token is an occurrence of: the form itself, or a table form followed by an apostrophe suffix. */
function declarableForm(
  form: string,
  forms: ReadonlyMap<string, string>,
): { base: string; tableWord: string; possessive: boolean } | undefined {
  const own = forms.get(form);
  if (own !== undefined) return { base: form, tableWord: own, possessive: false };
  const base = POSSESSIVE_TOKEN.exec(form)?.[1];
  const tableWord = base === undefined ? undefined : forms.get(base);
  return base !== undefined && tableWord !== undefined ? { base, tableWord, possessive: true } : undefined;
}

interface ResolvedReadings {
  occurrences: HeteronymOccurrence[];
  orphans: ReadingFinding[];
}

function resolveReadings(spoken: string, tokens: readonly PhonemeToken[], table: HeteronymTable): ResolvedReadings {
  const forms = formsOf(table);
  const declarations = declarationsOf(spoken);
  const targets = new Map(declarations.map((declaration) => [declaration.key, declaration.declared]));
  const markup = markupTargets(spoken);
  const seen = new Map<string, number>();
  const claimed = new Set<string>();
  const occurrences: HeteronymOccurrence[] = [];
  tokens.forEach((token, tokenIndex) => {
    const form = token.text.toLowerCase();
    const spelling = declarableForm(form, forms);
    if (spelling === undefined) return;
    const { tableWord } = spelling;
    const counter = spelling.possessive ? `${spelling.base}'` : spelling.base;
    const ordinal = (seen.get(counter) ?? -1) + 1;
    seen.set(counter, ordinal);
    const key = declarationKey(spelling.base, spelling.possessive, ordinal);
    const reading = readingOf(tableWord, token.phonemes, table);
    const declared = targets.get(key);
    if (declared !== undefined) claimed.add(key);
    const target = declared === undefined ? (spelling.possessive ? "" : (markup.get(occurrenceKey(form, ordinal)) ?? "")) : `=${declared}`;
    const finding = { word: token.text, occurrence: ordinal + 1, phonemes: token.phonemes, reading, ...statusOf(reading, target) };
    occurrences.push({ tokenIndex, tableWord, finding });
  });
  const orphans = declarations
    .filter(({ key }) => !claimed.has(key))
    .map(({ word, ordinal, declared }) => ({ word, occurrence: ordinal + 1, phonemes: null, reading: "unknown", declared, status: "fail" as const }));
  return { occurrences, orphans };
}

export function heteronymOccurrences(spoken: string, tokens: readonly PhonemeToken[], table: HeteronymTable): HeteronymOccurrence[] {
  return resolveReadings(spoken, tokens, table).occurrences;
}

/**
 * One finding per heteronym occurrence among the G2P tokens of `g2pText(spoken)`: its reading, its declaration, and its status.
 * A `[w](=reading)` declaration that no token matches is a `fail` finding with `phonemes: null`, never dropped.
 */
export function checkReadings(spoken: string, tokens: readonly PhonemeToken[], table: HeteronymTable = englishHeteronyms): ReadingFinding[] {
  const { occurrences, orphans } = resolveReadings(spoken, tokens, table);
  return [...occurrences.map(({ finding }) => finding), ...orphans];
}

/** Token text and the phonemes G2P chose for it, as the voice received them. */
export function tokenDump(tokens: readonly PhonemeToken[]): PhonemeToken[] {
  return tokens.map(({ text, phonemes, whitespace }) => ({ text, phonemes: phonemes ?? "", whitespace }));
}
