# @titan-design/speech-stt

Pure TypeScript helpers for checking speech against a script. No model runtime, no native
code and no ffmpeg.

- `SequenceMatcher`: CPython's `difflib.SequenceMatcher` (matching blocks, opcodes, ratio,
  autojunk), checked against goldens recorded from CPython.
- `align(script, heard)`: times each script word from a transcript's words. Matched words
  take their times; unmatched runs share the gap between matches evenly.
- `normalize(text)` and `diff(expected, heard)`: fold punctuation and formatting, then score
  a take by character similarity and list missing and extra words.
- `WordSchema`, `SegmentSchema`, `TranscriptSchema`: zod schemas for recogniser output.
- `resample(audio, toRate)`: a windowed-sinc resampler, so 24 kHz voice audio can feed a
  16 kHz recogniser.

```ts
import { align, diff, resample } from "@titan-design/speech-stt";

const audio16k = resample({ samples, sampleRate: 24000 }, 16000);
const words = align(scriptWords, transcript.words);
const { similarity, passed, issues } = diff(script, transcript);
```

The reference page, `site/reference/speech-stt.md`, covers gotchas and scope.

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.
