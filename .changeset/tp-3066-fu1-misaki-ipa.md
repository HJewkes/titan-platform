---
"@titan-design/speech-vet": minor
---

Add `misakiIpaG2p`, a `PhoneG2p` built on speech-g2p's `misakiEnglish().tokens()` and `misakiToIpa`, so expected phones need no espeak-ng binary (TP-3066). speech-vet now depends on `@titan-design/speech-g2p`, which must be published before speech-vet.
