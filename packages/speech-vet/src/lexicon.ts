import { z } from "zod";

const nonBlank = z.string().trim().min(1);

export const LexiconEntrySchema = z
  .object({
    /** Matched as a whole term, case-insensitively. */
    term: nonBlank,
    /** A display-to-spoken rewrite. */
    spoken: nonBlank.optional(),
    /** A one-token respelling for a voice that takes no phoneme input; a space would split it into two words. */
    respell: z.string().regex(/^\S+$/, "respell is a single token, with no whitespace").optional(),
    /** `misaki` is an inline override for misaki G2P; `ipa` is the espeak-IPA intent. */
    phonemes: z.object({ misaki: nonBlank.optional(), ipa: nonBlank.optional() }).strict().optional(),
    /** The measurement that justified the entry: the tool's score before and after it. */
    evidence: z.object({ tool: nonBlank, before: z.number(), after: z.number(), at: nonBlank }).strict().optional(),
  })
  .strict();

/** `lexicon.v1`: how each term is said aloud, by rewrite, respelling or phonemes. */
export const LexiconSchema = z.object({ schema: z.literal("lexicon.v1"), entries: z.array(LexiconEntrySchema) }).strict();

export type Lexicon = z.infer<typeof LexiconSchema>;
export type LexiconEntry = z.infer<typeof LexiconEntrySchema>;

/** Keys of a flat respelling map that annotate the file and are not words. */
const RESERVED_KEYS = new Set(["_comment"]);

const RespellingMapSchema = z.record(z.string(), z.string());
const UnversionedSchema = z.object({ entries: z.array(LexiconEntrySchema) }).strict();

function fromRespellingMap(map: Record<string, string>): Lexicon {
  const entries = Object.entries(map)
    .filter(([term]) => !RESERVED_KEYS.has(term))
    .map(([term, respell]) => LexiconEntrySchema.parse({ term, respell }));
  return { schema: "lexicon.v1", entries };
}

/**
 * Parses a `lexicon.v1` document. Also upgrades the two shapes that predate it: a flat `{ term: respelling }` map,
 * whose `_comment` key is dropped, and an unversioned `{ entries }` list. Throws a `ZodError` on anything else, and an
 * `Error` naming both terms when two terms differ only in case, since terms match case-insensitively and one would be lost.
 */
export function loadLexicon(json: unknown): Lexicon {
  const lexicon = parseLexicon(json);
  rejectCaseDuplicates(lexicon);
  return lexicon;
}

function parseLexicon(json: unknown): Lexicon {
  if (typeof json === "object" && json !== null && "schema" in json) return LexiconSchema.parse(json);
  const unversioned = UnversionedSchema.safeParse(json);
  if (unversioned.success) return { schema: "lexicon.v1", entries: unversioned.data.entries };
  return fromRespellingMap(RespellingMapSchema.parse(json));
}

function rejectCaseDuplicates(lexicon: Lexicon): void {
  const firstSeen = new Map<string, string>();
  for (const { term } of lexicon.entries) {
    const earlier = firstSeen.get(term.toLowerCase());
    if (earlier !== undefined && earlier !== term) throw new Error(`lexicon: terms differ only in case: "${earlier}" and "${term}"`);
    firstSeen.set(term.toLowerCase(), term);
  }
}

/** The `{ term: respelling }` map of the entries that carry a respelling. */
export function respellingsOf(lexicon: Lexicon): Record<string, string> {
  return Object.fromEntries(lexicon.entries.flatMap((entry) => (entry.respell === undefined ? [] : [[entry.term, entry.respell]])));
}
