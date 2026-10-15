# speech-g2p: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You turn English text into misaki phoneme tokens without Python, for Kokoro or for vetting pronunciations. This first slice ships the `G2pToken`, `Tokenizer` and `PosTagger` types and vendors misaki 0.9.4's US lexicon; the engine follows. Synthesis is `speech-tts`, and checking readings against declarations is `speech-vet`.
