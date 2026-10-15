# @titan-design/speech-stt

TypeScript helpers for checking speech against a script, plus Whisper and wav2vec2
recognisers. No ffmpeg. The recognisers need the optional peer `@huggingface/transformers`;
nothing else needs a model runtime or native code.

- `SequenceMatcher`: CPython's `difflib.SequenceMatcher` (matching blocks, opcodes, ratio,
  autojunk), checked against goldens recorded from CPython.
- `roundHalfEven(x, digits)`: Python's `round(x, digits)`, half to even on the exact binary
  value, where `toFixed` breaks exact ties upward (0.0625 to 3 places is 0.062, not 0.063).
- `align(script, heard)`: times each script word from a transcript's words. Matched words
  take their times; unmatched runs share the gap between matches evenly.
- `normalize(text)` and `diff(expected, heard)`: fold punctuation and formatting, then score
  a take by character similarity and list missing and extra words.
- `WordSchema`, `SegmentSchema`, `TranscriptSchema`: zod schemas for recogniser output.
- `resample(audio, toRate)`: a windowed-sinc resampler, so 24 kHz voice audio can feed a
  16 kHz recogniser.
- `whisperStt(options)`: Whisper word timestamps through transformers.js, with sub-word
  chunks merged into words and transcripts cached by audio hash. `device` and `cacheDir`
  go to the pipeline. Its `capabilities.tokenLogprobs` is `false`: transformers.js 3.8.1
  returns no token log-probs, so words carry no `probability` and `segments` is empty.
  Every `SttProvider` declares `capabilities: SttCapabilities`.
- `wav2vec2Recognizer(options)`: espeak-style IPA phones from `wav2vec2-lv-60-espeak-cv-ft`
  through transformers.js, pinned to one ONNX revision. `recognize` returns the raw greedy
  decode, cached by audio hash; `recognizeWithLogits` adds the per-frame ids and `CtcLogits`
  (20 ms frames) for forced alignment. `dtype` is `fp32` by default, which matches the PyTorch
  model frame for frame. `q8` is opt-in and gives **different verdicts**: it uses about 1.3 GB
  instead of 3 GB, but thresholds tuned on fp32 do not hold for it. Always pass `cacheDir`, and
  `dispose()` between phases. Feed chunk-length audio (30 s or less).
- `alignWords(script, phones, logits, { vocab, voice })`: force-aligns a script to those logits
  (`ctcForcedAlign` is the Viterbi underneath) and returns a `Word` per script word. `phones`
  is one raw IPA string per word, from your G2P. `voice` is required: `"kokoro"` or `"xtts"`
  shifts starts by a fitted offset, or pass `{ startOffsetS }`. Only starts are calibrated.

```ts
import { align, alignWords, diff, resample, wav2vec2Recognizer, whisperStt } from "@titan-design/speech-stt";

const audio16k = resample({ samples, sampleRate: 24000 }, 16000);
const words = align(scriptWords, transcript.words);
const { similarity, passed, issues } = diff(script, transcript);

const transcript = await whisperStt({ device: "cpu" }).transcribe(audio16k);

const phones = wav2vec2Recognizer({ device: "cpu", cacheDir });
const { phones: raw, logits } = await phones.recognizeWithLogits(audio16k);
const timed = alignWords(scriptWords, ipaPerWord, logits, { vocab: phones.vocab, voice: "kokoro" });
await phones.dispose();
```

The reference page, `site/reference/speech-stt.md`, covers gotchas and scope.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.
