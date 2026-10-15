---
"@titan-design/speech-stt": minor
---

Add `alignWords`, which force-aligns a script's IPA phones to wav2vec2 CTC logits and returns a `Word` per script word with a per-voice-family start offset (`kokoro` -0.056 s, `xtts` -0.029 s, or an explicit `startOffsetS`). Also exports `ctcForcedAlign`, `tokenizeIpa` and `CTC_START_OFFSET_S`. Only starts are calibrated; ends stay raw.
