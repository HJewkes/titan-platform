import { z } from "zod";
import enJson from "./heteronyms/en.json" with { type: "json" };
import { markupTargets, occurrenceKey } from "./markup.js";

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

export function heteronymOccurrences(spoken: string, tokens: readonly PhonemeToken[], table: HeteronymTable): HeteronymOccurrence[] {
  const forms = formsOf(table);
  const targets = markupTargets(spoken);
  const seen = new Map<string, number>();
  const occurrences: HeteronymOccurrence[] = [];
  tokens.forEach((token, tokenIndex) => {
    const form = token.text.toLowerCase();
    const tableWord = forms.get(form);
    if (tableWord === undefined) return;
    const ordinal = (seen.get(form) ?? -1) + 1;
    seen.set(form, ordinal);
    const reading = readingOf(tableWord, token.phonemes, table);
    const target = targets.get(occurrenceKey(form, ordinal)) ?? "";
    const finding = { word: token.text, occurrence: ordinal + 1, phonemes: token.phonemes, reading, ...statusOf(reading, target) };
    occurrences.push({ tokenIndex, tableWord, finding });
  });
  return occurrences;
}

/** One finding per heteronym occurrence among the G2P tokens of `g2pText(spoken)`: its reading, its declaration, and its status. */
export function checkReadings(spoken: string, tokens: readonly PhonemeToken[], table: HeteronymTable = englishHeteronyms): ReadingFinding[] {
  return heteronymOccurrences(spoken, tokens, table).map(({ finding }) => finding);
}

/** Token text and the phonemes G2P chose for it, as the voice received them. */
export function tokenDump(tokens: readonly PhonemeToken[]): PhonemeToken[] {
  return tokens.map(({ text, phonemes, whitespace }) => ({ text, phonemes: phonemes ?? "", whitespace }));
}
