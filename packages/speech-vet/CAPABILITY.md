# speech-vet: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You hold narration text and must say how its hard words are read before any audio exists: `[word](/phonemes/)` overrides and `[word](=reading)` declarations, a heteronym check of G2P tokens against those declarations, a `lexicon.v1` file of rewrites, respellings and phonemes, and dotted-letter initialisms. It is text-only and runs no G2P or model; tokens come from the caller. Synthesis belongs to speech-tts.
