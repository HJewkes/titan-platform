# speech-stt

**Tier 1 · engines.** No titan dependencies. Its one dependency is `zod`. The Whisper and
wav2vec2 recognisers need the optional peer `@huggingface/transformers` (`^3`); everything
else runs without a model runtime or native code.

```sh
npm install @titan-design/speech-stt
```

## The problem it solves

Speech checks are mostly sequence comparison: line a script up against what a recogniser
heard, time each script word, and score how close a take came. The Python originals rely on
CPython's `difflib.SequenceMatcher`, and their thresholds were tuned on its exact output, so
any other diff algorithm shifts every verdict. They also called ffmpeg to resample a voice's
24 kHz audio to a recogniser's 16 kHz.

This package ports those pieces to TypeScript. `SequenceMatcher` returns CPython's matching
blocks, opcodes and ratio, autojunk included, and is checked against goldens recorded from
CPython. `align`, `diff` and `normalize` are ports of the code that used it, and `resample`
replaces the ffmpeg call.

## When to reach for it

You compare a script with a transcript, or you port Python code that calls `difflib`. Use
`align` to give every script word a time, `diff` to score a take, and `resample` to feed a
16 kHz recogniser. Use `whisperStt` to get a `Transcript` with word timestamps from audio.
Use `wav2vec2Recognizer` to hear which phones were actually spoken, or to get CTC logits for
forced alignment.
Speech synthesis belongs to `speech-tts`.

## Example

Verified against the 0.0.0 workspace build.

```ts
import { align, diff, resample, SequenceMatcher } from "@titan-design/speech-stt";

new SequenceMatcher("qabxcd", "abycdf").ratio(); // 0.6666666666666666, as CPython

align(["Start", "alpha", "beta", "gamma", "finish"], [
  { text: "start", start: 0.5, end: 1.0 },
  { text: "finish", start: 1.6, end: 2.0 },
]); // alpha 1.0-1.2, beta 1.2-1.4, gamma 1.4-1.6

diff("The U.S. army.", "the us army").passed; // true

resample({ samples, sampleRate: 24000 }, 16000).samples.length; // Math.round(samples.length * 2 / 3)
```

The recogniser runs `onnx-community/whisper-base.en_timestamped` through transformers.js.
`device` and `cacheDir` go to the pipeline; `cacheDir` is where model weights live.

```ts
import { whisperStt } from "@titan-design/speech-stt";

const stt = whisperStt({ device: "cpu", cacheDir: "/var/cache/models" });
const transcript = await stt.transcribe({ samples, sampleRate: 24000 });
transcript.words; // [{ text: "The", start: 0, end: 0.68 }, { text: "redesign", start: 0.68, end: 0.9 }, ...]
await stt.dispose();
```

The phone recogniser runs `onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX`, pinned to
`WAV2VEC2_REVISION`, and decodes greedily over a vocab vendored in `data/`.

```ts
import { wav2vec2Recognizer } from "@titan-design/speech-stt";

const phones = wav2vec2Recognizer({ device: "cpu", cacheDir: "/var/cache/models" });
await phones.recognize({ samples, sampleRate: 24000 }); // "w ʌ n s ɪ t ɹ iː tʃ ᵻ z ..."
const { ids, logits } = await phones.recognizeWithLogits(audio);
logits.frames; // one row of logits.vocabSize scores per 20 ms (logits.frameS)
await phones.dispose();
```

`alignWords` times a script against those logits. The caller supplies one IPA string per
script word from its own G2P, and the voice family picks the start offset.

```ts
import { alignWords } from "@titan-design/speech-stt";

const { logits } = await phones.recognizeWithLogits(audio16k);
alignWords(["all", "llamas"], ["ɔːl", "lɑːməz"], logits, { vocab: phones.vocab, voice: "kokoro" });
// [{ text: "all", start: 0.084, end: 0.2 }, { text: "llamas", start: 0.164, end: 0.34 }]
```

## What it deliberately does not do

- One word recogniser backend, Whisper. A spike compared it with Parakeet over sherpa-onnx.
  Parakeet scored a lower word error rate, but it read garbled synthetic speech as the
  intended words, which makes it worse at catching bad takes. So there is no sherpa peer.
- No segment confidence. Word-timestamp decoding in transformers.js reports none, so
  `Transcript.segments` is empty and `whisperStt` declares `capabilities.tokenLogprobs: false`.
  `SttProvider.capabilities` is required; a provider that fills word `probability` and segment
  `avgLogprob` / `compressionRatio` from token log-probs declares it `true`.
- No prompt or language option yet. The default model is English only.
- No `isjunk` callback on `SequenceMatcher`. None of the ported callers used one.
- No file or WAV handling. `resample` takes and returns `{ samples, sampleRate }`.

## Gotchas

- `SequenceMatcher` turns autojunk on by default, as CPython does. With 200 or more items in
  `b`, any item filling over 1% of `b` cannot anchor a match. `align` turns it off.
- Strings iterate by code point, as in Python, so an emoji is one item, not two.
- `diff` lists insertions and deletions in first-seen order. The original took them from a
  Python set, whose order changes between runs.
- `align` throws when the transcript has no words, because there is nothing to anchor to.
- `align` rounds times to milliseconds half to even, as Python's `round` does.
- `whisperStt` caches transcripts by a SHA-256 of the model, sample rate and samples, in a
  `Map` per recogniser unless you pass `cache`. A second `transcribe` of the same audio does
  not run the model. The map is unbounded, so pass your own store for long-lived processes.
- Without `@huggingface/transformers` installed, the first `transcribe` throws an error
  naming `npm i @huggingface/transformers`. Importing the package never loads the peer.
- Audio at any rate is resampled to 16 kHz with `resample` first. Whisper gives a window's
  last word a null end time; that word ends where it starts.
- `wav2vec2Recognizer` defaults to `fp32`, which gives the same frame ids as the PyTorch
  model. `q8` is opt-in: it uses about 1.3 GB of memory instead of 3 GB, but a parity run
  changed the phone-check verdict on 7 of 30 chunks, so thresholds tuned on fp32 do not hold
  for it. There is no silent fallback to q8.
- `recognize` returns the raw decode: space-separated vocab tokens with `<pad>`, `<s>`,
  `</s>` and `<unk>` dropped and nothing folded. Cleaning is the caller's job. Decodes are
  cached by model, dtype, revision and audio; `recognizeWithLogits` always runs the model.
- Without `cacheDir`, transformers.js caches weights inside `node_modules`, which a reinstall
  wipes. A pinned revision lives under `<cacheDir>/<model>/<revision>/`.
- With `TITAN_SPEECH_OFFLINE` set, `wav2vec2Recognizer` throws `offline:` before any network
  call unless that exact weights file (`onnx/model.onnx`, or `onnx/model_quantized.onnx` for
  q8) is cached.
- wav2vec2 attends over the whole input, so memory grows with the square of its length. Feed
  chunk-length audio, 30 s or less. Audio under 400 samples at 16 kHz is refused.
- Whisper's word times run early, by 80 to 170 ms on average with a long tail. Use a forced
  aligner when captions need tight boundaries.
- `alignWords` offsets were fitted on espeak en-us targets and wav2vec2-lv-60 at the pinned
  revision. Another G2P, model or voice needs its own `startOffsetS`.
- Only starts are calibrated. Ends land about 30 to 60 ms early, so take a caption's end from
  the next word's start in the renderer.
- Feed `alignWords` the same chunk-length audio the recogniser takes (30 s or less): the
  Viterbi keeps one byte per frame and state.
- A word with no alignable phones (punctuation, or a G2P miss that returned `""`) gets a
  zero-length span, so the output stays one-to-one with the script.

## Where it came from

Ported from two Python narration pipelines: one's word alignment (`align`) and the other's
text comparison (`normalize`, `diff`), with `difflib.SequenceMatcher` ported from CPython.
It is slice T1 of the speech packages (TP-2956). The Whisper recogniser is slice T2 (TP-3028),
and the wav2vec2 phone recogniser is part of T8 (TP-3033). Forced alignment is T14 (TP-3035).
