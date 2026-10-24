import { misakiEnglish, type G2p } from "@titan-design/speech-g2p";
import { misakiWords } from "./tts-engine.js";

let voiceG2p: G2p | undefined;

/** The voice's g2p over the doctrine lexicon, built once: the words it reads no phonemes for are the ones tts stops on. */
export const doctrineG2p = (): G2p => (voiceG2p ??= misakiEnglish({ words: misakiWords() }));
