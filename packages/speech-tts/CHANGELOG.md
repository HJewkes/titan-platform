# @titan-design/speech-tts

## 0.1.1

### Patch Changes

- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 10c117f: Fix Kokoro word timings after a word with no phonemes: the timeline no longer drifts one id per such word, so the last word keeps its timing. The "does not speak" warning names the 510-phoneme cut only when a chunk was cut.
- Updated dependencies [5edd38d]
  - @titan-design/rpc-protocol@0.4.0

## 0.1.0

### Minor Changes

- 1b17331: Add speech-tts: the `TtsProvider` contract with capability descriptors and typed errors, a registry that selects a provider from a profile plus `TITAN_SPEECH_*` env overrides, and the `fakeTts`, `commandTts` (stdio JSON in, WAV or JSON out, process-group kill on timeout) and `httpTts` (template-mapped, no vendor SDK) adapters, all passing one conformance kit. Safe defaults for other deployments: no redirects, no plain http off loopback without `allowInsecureHttp`, a streamed `maxOutputBytes` cap (64 MB), a minimal command environment, secrets redacted from error text, a JSON `wav` path confined to the call's `outDir`, fail-closed selection on misconfiguration unless `tts.fallback` is set, and an `unknown-kind` error, which never falls back, for a provider kind with no registered factory.
- 4c09b9a: Add `kokoroProvider` and `kokoroFactory`: Kokoro-82M in process at fp32 through the optional `@huggingface/transformers` peer (voices from the optional `kokoro-js` peer). It takes misaki tokens, or text through an injected G2P, chunks at 510 phonemes, and returns word timings from the model's own durations that match Python's `KPipeline.join_timestamps`. A word with no phonemes keeps a zero-width timing and raises a warning. `TITAN_SPEECH_OFFLINE` refuses an uncached model before the peer loads. Also exports `KOKORO_CAPABILITIES`, the `KokoroG2p` and `KokoroEngine` seams, and `TokenTime`.
- 110547b: Add `speakingSeconds`, which measures the speech in a clip without leading, trailing or pause silence, and `calibrateSpeed`, which tunes a provider's speed until a script reads at a target words-per-minute.
- 57c76dd: Add `detectSpeechRuntime` and `runtimeOptions`: pick each speech model's device (cpu by default; cuda reported, and
  refused as unverified until spike E9) and the model cache directory from the platform, `TITAN_SPEECH_DEVICE`,
  `TITAN_SPEECH_DEVICE_<TTS|STT|PHONES>`, `TITAN_SPEECH_CACHE` and a new `runtime` section in the profile. The default
  cache comes from `@titan-design/app-paths`, now a runtime dependency.
- fca61b7: Add `resolveSpeechRuntime`, which loads the profile through `TITAN_SPEECH_PROFILE`, looks for onnxruntime-node beside
  the transformers.js peer and runs `detectSpeechRuntime` on the real host. `kokoroFactory` takes a `runtime`: its
  env-chosen device and cache beat a profile entry's, and its other values fill what the entry omits.
- a6f6ee5: Add `unknownWords: "warn" | "fail"` to `kokoroProvider` and to Kokoro profile entries. With `"fail"`, synthesis rejects before the model loads with the new `TtsUnknownWordsError` (code `unknown-words`), whose `words` lists every word with no phonemes and its token index. `"warn"` stays the default: such a word keeps its zero-width timing and a warning.

### Patch Changes

- 41e22b4: commandTts hardening (TP-3017): a named WAV with more than one hard link is refused, a JSON `wav` must be a bare filename, a failed scratch-directory cleanup is logged instead of replacing the result, and an already-aborted signal rejects without spawning the command.
- 37c0274: Add Kokoro's 510-phoneme chunking (internal for now): a port of kokoro's `en_tokenize` and `waterfall_last`, the 510 cut `generate_from_tokens` applies, the voice-pack style row `len(ps) - 1`, and an offset that puts later chunks' word times on one clock, pinned by a golden recorded from Python Kokoro without a model.
- fc60b0a: Document the Kokoro provider in the README, `CAPABILITY.md` and the reference page, and add an opt-in smoke test that runs the real fp32 model against the golden beats.
- 324c4fd: Test `kokoroProvider` end to end with the real misaki G2P from `@titan-design/speech-g2p`, replaying Python's frames for the r4-8 beat. The G2P is a workspace devDependency only; it adds no runtime or peer dependency.
- a8eb644: Add Kokoro's timing core (internal for now): a port of kokoro's `join_timestamps` with the divisor derived from the 600-sample hop, half-to-even duration rounding clamped to one frame, and a check that the frames sum to the waveform length, pinned by a golden recorded from Python Kokoro.
- bd52653: Document device and model-cache selection: the `TITAN_SPEECH_DEVICE[_TTS|_STT|_PHONES]` and `TITAN_SPEECH_CACHE`
  variables, the profile `runtime` section, `resolveSpeechRuntime`, and why `cuda` is listed but refused until it is
  verified.
- 063cd08: Add the unpublished `smoke:speech` script (spike E8 promoted): Kokoro, Whisper and wav2vec2 on one constructed sentence, with `--suite`, `--device` and `--profile` resolved through `resolveSpeechRuntime`, and a zod-checked JSON report whose RTF is audio seconds / wall seconds. The published package is unchanged; the README gains a section on running it.
