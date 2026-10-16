---
"@titan-design/speech-vet": minor
---

`checkReadings` reports a `[w](=reading)` declaration that no token matches as a `fail` finding instead of dropping it, and reads a possessive token such as `lead's` as the declared `lead` so it no longer skews later ordinals. `loadLexicon` throws when two terms differ only in case, naming both.
