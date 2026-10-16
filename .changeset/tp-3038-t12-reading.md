---
"@titan-design/speech-vet": minor
---

speech-vet: add `checkHeardReadings`, the post-synthesis reading check. It aligns a phone recognizer's output to the IPA of the tokens the voice was given and reports, per declared `[word](=reading)` heteronym, the reading heard and `ok`, `fail` or `inconclusive`. Expected phones come from an injected misaki-to-IPA map (speech-g2p's `misakiToIpa` fits), so it needs no espeak-ng. `readingIpa` and `expandReading` expose each reading's IPA.
