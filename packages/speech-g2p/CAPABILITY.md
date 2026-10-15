# speech-g2p: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You turn English text into misaki 0.9.4 phoneme tokens without Python, for Kokoro or for vetting pronunciations: `misakiEnglish()` gives per-token phonemes, the joined string and a cache `version`, honours `[word](/phonemes/)` overrides, and `ttsTokens` hands them to speech-tts. `misakiToIpa` converts the result to IPA. Words outside misaki's lexicon come back unread (`phonemes: null`) unless you pass a `fallback`. Synthesis is `speech-tts`, and checking readings against declarations is `speech-vet`.
