import type { G2p } from "@titan-design/speech-g2p";
import type { L0Result } from "./eval-l0.js";
import type { ScriptV1 } from "./script-schema.js";

/** A token the voice must say, as speech-tts's strict mode counts it: one holding a letter or a digit. */
const IS_WORD = /[\p{L}\p{N}]/u;

export type Tokens = Pick<G2p, "tokens">;

interface UnknownWord {
  beat: string;
  word: string;
}

/**
 * The spoken words g2p reads no phonemes for, by beat. It tests the phonemes, not misaki's rating, which is null on
 * some paths for a word it does read; the voice's strict mode stops on exactly these words.
 */
export function unknownWords(g2p: Tokens, script: Pick<ScriptV1, "beats">): UnknownWord[] {
  return script.beats.flatMap(({ id, spoken }) =>
    g2p.tokens(spoken).flatMap((token) => (IS_WORD.test(token.text) && !token.phonemes ? [{ beat: id, word: token.text }] : [])),
  );
}

/** The repair row's id; the script stage's `unknown-words` gate checks the same words after the repair rounds. */
export const UNKNOWN_WORDS_ID = "unknown-words";
export const UNKNOWN_WORDS_RULE = "every spoken word must be one the voice has phonemes for";

const MIN_PART = 2;
const reads = (g2p: Tokens, text: string): boolean => g2p.tokens(text).every((token) => !IS_WORD.test(token.text) || Boolean(token.phonemes));

/** Two words the voice reads that join to `word`, split as evenly as any split reads; undefined when none does. */
export function splitWord(g2p: Tokens, word: string): string | undefined {
  const splits = [...Array(Math.max(0, word.length - 2 * MIN_PART + 1)).keys()]
    .map((i) => [word.slice(0, i + MIN_PART), word.slice(i + MIN_PART)] as const)
    .filter((parts) => parts.every((part) => reads(g2p, part)))
    .sort((a, b) => Math.min(b[0].length, b[1].length) - Math.min(a[0].length, a[1].length));
  return splits[0]?.join(" ");
}

/** A repair row over the words the voice cannot say, so the rounds fix them before the hard gate reads them. */
export function unknownWordsRow(g2p: Tokens, script: Pick<ScriptV1, "beats">): L0Result {
  const unknown = unknownWords(g2p, script);
  const beats = [...new Set(unknown.map(({ beat }) => beat))];
  return { check_id: UNKNOWN_WORDS_ID, mode: "tagged", severity: "error", value: unknown.length, threshold: 0, pass: unknown.length === 0, detail_beats: beats };
}

/** Each unsayable word with the split that reads, if one does, as the edit a repair makes in the spoken text. */
export function unknownWordsHint(g2p: Tokens, script: Pick<ScriptV1, "beats">): string {
  const named = [...new Set(unknownWords(g2p, script).map(({ beat, word }) => {
    const split = splitWord(g2p, word);
    return `${beat} "${word}"${split ? ` (write "${split}")` : ""}`;
  }))];
  return `the voice has no phonemes for ${named.join("; ")}. Respell or split each in spoken into words a listener hears the same way, and change any atCue that names it to match`;
}
