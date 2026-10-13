import { z } from "zod";

const LexiconEntrySchema = z.object({
  term: z.string().min(1),
  spoken: z.string().min(1),
});

/** `lexicon.json`: how a written term is said aloud, so the display text and the narration can differ. */
export const LexiconSchema = z.object({ entries: z.array(LexiconEntrySchema) });

export type Lexicon = z.infer<typeof LexiconSchema>;
export type LexiconEntry = Lexicon["entries"][number];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-term match: `CI` must not hit inside `CIRCLE`, and terms like `C++` end on a non-word character.
function mentions(text: string, term: string): boolean {
  return new RegExp(`(?<![\\w])${escapeRegExp(term)}(?![\\w])`, "i").test(text);
}

/** The entries whose term appears in any of the texts, in lexicon order. */
export function lexiconEntriesFor(lexicon: Lexicon, texts: readonly string[]): LexiconEntry[] {
  return lexicon.entries.filter((entry) => texts.some((text) => mentions(text, entry.term)));
}
