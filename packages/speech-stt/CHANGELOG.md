# @titan-design/speech-stt

## 0.1.1

### Patch Changes

- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- Updated dependencies [5edd38d]
  - @titan-design/rpc-protocol@0.4.0

## 0.1.0

### Minor Changes

- 3a3c321: Add speech-stt: a CPython-parity `SequenceMatcher` (matching blocks, opcodes, ratio, autojunk) checked against CPython goldens, `align` to time script words from a transcript, `normalize` and `diff` to score a take against its script, zod `Word`, `Segment` and `Transcript` schemas, and a pure TypeScript windowed-sinc `resample` so 24 kHz audio reaches a 16 kHz recogniser without ffmpeg.
- 16a909c: Add `whisperStt`, a transformers.js Whisper recogniser (`onnx-community/whisper-base.en_timestamped` by default) that returns word-timed transcripts. It merges sub-word chunks into words, caches transcripts by audio hash, resamples to 16 kHz and passes `device` and `cacheDir` to the pipeline. `@huggingface/transformers` ^3 is an optional peer; when it is missing, the error names `npm i @huggingface/transformers`.
- d3f133d: speech-vet: add the phone check, a port of the audiobook backend's phoneme validation at verdict parity. `chunkWordVerdicts` gives each target word an `xtts`, `whisper` or `inconclusive` verdict, `detectHallucinations` finds babble runs and `detectTailArtifact` finds stray phones after the last word. G2P is injected as `PhoneG2p` (espeak-ng's raw `--ipa=3` output, voice `en-us` by default), and `recognizePhones` cleans a recognizer's raw decode. speech-vet now depends on speech-stt.

  speech-stt: export `roundHalfEven(x, digits)`, Python's `round`, half to even on the exact binary value.

- e18ac5e: Add `wav2vec2Recognizer`: espeak-style phone recognition with `wav2vec2-lv-60-espeak-cv-ft` over transformers.js, pinned to one ONNX revision, with `dtype` (`fp32` by default; `q8` gives different verdicts), `device`, `cacheDir`, `revision` and `threads`. `recognizeWithLogits` returns the per-frame `CtcLogits`, ids and greedy decode for forced alignment. The vocab is vendored in `data/`. Under TITAN_SPEECH_OFFLINE it refuses to load unless the exact weights file for the requested dtype and revision is cached.
- 67278c2: Add `alignWords`, which force-aligns a script's IPA phones to wav2vec2 CTC logits and returns a `Word` per script word with a per-voice-family start offset (`kokoro` -0.056 s, `xtts` -0.029 s, or an explicit `startOffsetS`). Also exports `ctcForcedAlign`, `tokenizeIpa` and `CTC_START_OFFSET_S`. Only starts are calibrated; ends stay raw.
- cca14b1: `SttProvider` gains a required `capabilities: SttCapabilities` with `tokenLogprobs`, true when word `probability` and segment `avgLogprob` / `compressionRatio` come from token log-probs. `whisperStt` declares it `false`, because transformers.js 3.8.1 returns no token scores.
- 29ed958: `whisperStt` now declares `capabilities.tokenLogprobs: true`. A logits processor records each decode step's token
  log-prob, so words carry `probability` and each 30 s decode window is one segment with `avgLogprob` and
  `compressionRatio`, with faster-whisper's semantics. `whisperStt({ tokenLogprobs: false })` keeps the old shape: no
  `probability` and empty `segments`. `defectOptionsFor(whisperStt())` therefore turns speech-vet's signal A on.

### Patch Changes

- fd70652: `whisperStt` throws an `offline:` error, before any network call, when `TITAN_SPEECH_OFFLINE` is set and the model is not in `cacheDir`.
