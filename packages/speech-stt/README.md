# @titan-design/speech-stt

TypeScript helpers for checking speech against a script, plus a Whisper recogniser. No
ffmpeg. The recogniser needs the optional peer `@huggingface/transformers`; nothing else
needs a model runtime or native code.

- `SequenceMatcher`: CPython's `difflib.SequenceMatcher` (matching blocks, opcodes, ratio,
  autojunk), checked against goldens recorded from CPython.
- `align(script, heard)`: times each script word from a transcript's words. Matched words
  take their times; unmatched runs share the gap between matches evenly.
- `normalize(text)` and `diff(expected, heard)`: fold punctuation and formatting, then score
  a take by character similarity and list missing and extra words.
- `WordSchema`, `SegmentSchema`, `TranscriptSchema`: zod schemas for recogniser output.
- `resample(audio, toRate)`: a windowed-sinc resampler, so 24 kHz voice audio can feed a
  16 kHz recogniser.
- `whisperStt(options)`: Whisper word timestamps through transformers.js, with sub-word
  chunks merged into words and transcripts cached by audio hash. `device` and `cacheDir`
  go to the pipeline.

```ts
import { align, diff, resample, whisperStt } from "@titan-design/speech-stt";

const audio16k = resample({ samples, sampleRate: 24000 }, 16000);
const words = align(scriptWords, transcript.words);
const { similarity, passed, issues } = diff(script, transcript);

const transcript = await whisperStt({ device: "cpu" }).transcribe(audio16k);
```

The reference page, `site/reference/speech-stt.md`, covers gotchas and scope.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.
