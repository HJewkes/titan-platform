---
"@titan-design/explainer": patch
---

The tts stage voices `doctrine/lexicon.json` (`lexicon.v1`): each entry's `phonemes.misaki` reaches Kokoro through speech-g2p's `words`, and a hash of those words joins the engine version, so a phoneme edit re-voices every take. An unknown word still fails before the model loads. The first entry, `ffmpeg`, is a placeholder reading.
