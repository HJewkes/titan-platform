import type { G2p } from "@titan-design/speech-g2p";
import type { ScriptV1 } from "./script-schema.js";

/** A token the voice must say, as speech-tts's strict mode counts it: one holding a letter or a digit. */
const IS_WORD = /[\p{L}\p{N}]/u;

interface UnknownWord {
  beat: string;
  word: string;
}

/**
 * The spoken words g2p reads no phonemes for, by beat. It tests the phonemes, not misaki's rating, which is null on
 * some paths for a word it does read; the voice's strict mode stops on exactly these words.
 */
export function unknownWords(g2p: Pick<G2p, "tokens">, script: Pick<ScriptV1, "beats">): UnknownWord[] {
  return script.beats.flatMap(({ id, spoken }) =>
    g2p.tokens(spoken).flatMap((token) => (IS_WORD.test(token.text) && !token.phonemes ? [{ beat: id, word: token.text }] : [])),
  );
}
