---
"@titan-design/speech-g2p": minor
---

Add the public G2P: `misakiEnglish()` (tokens, phonemize, version) over the spaCy tokenizer port and the compromise tagger, and `ttsTokens()` for speech-tts. End-to-end parity with misaki 0.9.4 and spaCy is 99.324 % stress-strict on the CI golden and 99.42 % on the E4 corpus. The tagger now tags whitespace `_SP`, a plural possessive apostrophe `POS` and every currency symbol `$`, as spaCy does.
