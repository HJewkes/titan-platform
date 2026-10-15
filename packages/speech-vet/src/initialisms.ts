/**
 * Spell out all-caps initialisms so a voice reads them letter by letter.
 *
 * A voice reads an unfamiliar all-caps token as a word ("ASAP" as "asaps"). Dotted letters ("A. S. A. P.") make it
 * say the letter names; bare spaced letters do not, because a lone "A" is read as the article. Not every all-caps
 * token is an initialism, though: prose shouts ordinary words ("I did NOT") and names acronyms said as words. So the
 * rule branches on token shape:
 *
 * - Two letters: spell out, except English two-letter words that only appear shouted (TO, IS, MY), interjections
 *   (OI, UM, OK), am/pm and Roman numerals.
 * - Three to five letters with no vowel (Y counts as one): spell out, since it cannot be read as a word (BBC),
 *   except interjections (HMM, HMPH).
 * - Three to five letters with a vowel: spell out only if listed. Most such tokens are shouted words, so a general
 *   rule here would spell out "NOT" and "BEST". A product adds its own domain's list through `spelled`.
 *
 * A trailing lowercase plural "s" stays on the last letter as "'s" ("CEOs" to "C. E. O's"), and tokens inside
 * contractions ("I'LL", "DON'T") are left alone.
 */

export const SHOUTED_TWO_LETTER_WORDS: ReadonlySet<string> = new Set([
  "AH", "AM", "AN", "AS", "AT", "AU", "AW", "BE", "BY", "DO", "EH", "GO",
  "HA", "HE", "HI", "IF", "IN", "IS", "IT", "ME", "MM", "MY", "NO", "OF",
  "OH", "OI", "OK", "ON", "OR", "OW", "PM", "SO", "TO", "UH", "UM", "UP",
  "US", "WE", "YA", "YO",
]);

export const VOWELLESS_INTERJECTIONS: ReadonlySet<string> = new Set([
  "BRR", "GRR", "GRRR", "HMM", "HMMM", "HMPH", "MMM", "MMMM", "PFFT", "PSST",
  "SHH", "SHHH", "TSK", "ZZZ",
]);

/** General-English initialisms that contain a vowel; domain lists come from the caller. */
export const SPELLED_INITIALISMS: ReadonlySet<string> = new Set([
  "AKA", "ASAP", "CEO", "CFO", "COO", "DNA", "FBI", "IOU", "IMO", "IRL",
  "MRI", "OMG", "POV", "QED", "ROI", "SEO", "SUV", "UFO", "USB", "VIP",
]);

export interface InitialismOptions {
  /** Vowel-bearing tokens to spell out, beyond {@link SPELLED_INITIALISMS}. */
  spelled?: Iterable<string>;
}

const VOWELS = /[AEIOUY]/;
const ROMAN_NUMERAL = /^[IVX]+$/;
const CAPS_TOKEN = /(?<![\p{L}\p{N}_'’])([A-Z]{2,5})(s?)(?![\p{L}\p{N}_])(?!['’][A-Z])/gu;
const SENTENCE_END = new Set([".", "!", "?", "…"]);

/** Whether an all-caps token should be read letter by letter. */
export function isInitialism(token: string, spelled: ReadonlySet<string> = SPELLED_INITIALISMS): boolean {
  if (ROMAN_NUMERAL.test(token)) return false;
  if (token.length === 2) return !SHOUTED_TWO_LETTER_WORDS.has(token);
  if (!VOWELS.test(token)) return !VOWELLESS_INTERJECTIONS.has(token);
  return spelled.has(token);
}

/** Replaces every initialism in `text` with its dotted letters. */
export function spellInitialisms(text: string, opts: InitialismOptions = {}): string {
  const spelled = new Set([...SPELLED_INITIALISMS, ...(opts.spelled ?? [])]);
  return text.replace(CAPS_TOKEN, (match: string, token: string, plural: string, offset: number) => {
    if (!isInitialism(token, spelled)) return match;
    const letters = [...token].join(". ");
    if (plural) return `${letters}'s`;
    return SENTENCE_END.has(text.charAt(offset + match.length)) ? letters : `${letters}.`;
  });
}
