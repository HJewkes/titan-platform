import { LexiconEntrySchema, type LexiconEntry } from "@titan-design/speech-vet";
import { z } from "zod";

/** `lexicon.json`: how a written term is said aloud. The entry shape is speech-vet's `lexicon.v1`; the `schema` tag is optional so packets written before it existed still load. */
export const LexiconSchema = z.object({ schema: z.literal("lexicon.v1").optional(), entries: z.array(LexiconEntrySchema) });

export type Lexicon = z.infer<typeof LexiconSchema>;
export type { LexiconEntry };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-term match: `CI` must not hit inside `CIRCLE`, and terms like `C++` end on a non-word character.
const termPattern = (term: string): RegExp => new RegExp(`(?<![\\w])${escapeRegExp(term)}(?![\\w])`, "i");

export function mentions(text: string, term: string): boolean {
  return termPattern(term).test(text);
}

/** The term as `text` spells it at its first whole-term mention, or null if it is not mentioned. */
export const spelledAs = (text: string, term: string): string | null => termPattern(term).exec(text)?.[0] ?? null;

/** The entries whose term appears in any of the texts, in lexicon order. */
export function lexiconEntriesFor(lexicon: Lexicon, texts: readonly string[]): LexiconEntry[] {
  return lexicon.entries.filter((entry) => texts.some((text) => mentions(text, entry.term)));
}
