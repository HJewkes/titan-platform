---
"@titan-design/speech-vet": minor
---

Add speech-vet part 1, a TypeScript port of the narration text checks: `plainText` and `g2pText` for `[word](/phonemes/)` overrides and `[word](=reading)` declarations, `checkReadings` against the 19-word misaki heteronym table in `heteronyms/en.json`, the zod `lexicon.v1` schema with `loadLexicon` (it upgrades a flat respelling map and an unversioned entries list), `respeller` and `generateCandidates`, and `spellInitialisms`. The vowel-bearing initialism list holds general English only; a product passes its own domain list through `spelled`.
