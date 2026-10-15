import { misakiToIpa, type G2p } from "@titan-design/speech-g2p";
import type { PhoneG2p } from "./phones.js";

// Misaki gives punctuation tokens phonemes of their own (`.`, `,`, `—`, quotes); espeak's --ipa output never
// carries them, and left in they would count as expected phones.
const PUNCTUATION = /\p{P}/gu;

/**
 * A `PhoneG2p` backed by speech-g2p's pure-TypeScript misaki G2P, so expected phones need no espeak-ng binary.
 * Each token becomes one IPA word with stress marks and punctuation removed, as the espeak path's cleaned words
 * have neither; a token with no phones becomes an empty word, which `g2pSentence` drops. Misaki is US English
 * only, so the `voice` argument is ignored. Verdict thresholds were tuned on espeak, so verdicts can differ.
 */
export function misakiIpaG2p(g2p: Pick<G2p, "tokens">): PhoneG2p {
  return (text) =>
    g2p
      .tokens(text)
      .map(({ phonemes }) =>
        phonemes === null ? "" : misakiToIpa(phonemes, { stress: "strip" }).replace(PUNCTUATION, ""),
      )
      .join(" ");
}
