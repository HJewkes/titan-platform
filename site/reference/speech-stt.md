# speech-stt

**Tier 1 · engines.** No titan dependencies. Its one dependency is `zod`. The Whisper
recogniser needs the optional peer `@huggingface/transformers` (`^3`); everything else runs
without a model runtime or native code.

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

## What it deliberately does not do

- One recogniser backend, Whisper. A spike compared it with Parakeet over sherpa-onnx.
  Parakeet scored a lower word error rate, but it read garbled synthetic speech as the
  intended words, which makes it worse at catching bad takes. So there is no sherpa peer.
- No segment confidence. Word-timestamp decoding in transformers.js reports none, so
  `Transcript.segments` is empty.
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
- Whisper's word times run early, by 80 to 170 ms on average with a long tail. Use a forced
  aligner when captions need tight boundaries.

## Where it came from

Ported from two Python narration pipelines: one's word alignment (`align`) and the other's
text comparison (`normalize`, `diff`), with `difflib.SequenceMatcher` ported from CPython.
It is slice T1 of the speech packages (TP-2956). The Whisper recogniser is slice T2 (TP-3028).
