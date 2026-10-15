---
"@titan-design/speech-tts": minor
---

Add `kokoroProvider` and `kokoroFactory`: Kokoro-82M in process at fp32 through the optional `@huggingface/transformers` peer (voices from the optional `kokoro-js` peer). It takes misaki tokens, or text through an injected G2P, chunks at 510 phonemes, and returns word timings from the model's own durations that match Python's `KPipeline.join_timestamps`. A word with no phonemes keeps a zero-width timing and raises a warning. `TITAN_SPEECH_OFFLINE` refuses an uncached model before the peer loads. Also exports `KOKORO_CAPABILITIES`, the `KokoroG2p` and `KokoroEngine` seams, and `TokenTime`.
