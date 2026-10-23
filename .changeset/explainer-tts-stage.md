---
"@titan-design/explainer": minor
---

Run the `explainer.tts` stage in TypeScript (TP-2615, X6) instead of the bridge. Each beat is voiced by speech-tts Kokoro with `unknownWords: "fail"` in the voice band of the run's profile (a tts variant may set `voice` and `rate`), re-timed against the script (the `realign.py` port; its homophone map is `HOMOPHONES` in the lexicon), and trued to `max(plannedS, lead + speech + tail)` on a whole frame. The stage writes the WAV tree, `words.json` (per-beat `startS`, beat-relative `words`, and `absolute` word times on the video timeline) and `voice.json`. Takes are cached per beat under `sha(spoken, voice, rate, engine version)`. A `bridge.json` that still has a `tts` block is refused with what to move.
