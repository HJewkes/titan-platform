# Kokoro fixtures

Golden data recorded from Python Kokoro, once and offline. Nothing in the package, its tests or
CI runs Python, loads a model or touches the network; the tests only read the files below.

## Files

| File | Contents | Source |
|---|---|---|
| `r4-8.golden.json` | one beat of our own explainer script: `ps` (141 phonemes), `input_ids`, `style_index` 140, `pred_dur` (143 rounded frames: `<bos>`, phonemes, `<eos>`), `audio_samples` 272,400, and the 32 misaki tokens with Python's `start_ts`/`end_ts` | `KPipeline.generate_from_tokens` |

## r4-8.golden.json

Recorded by the Kokoro-in-TypeScript spike (E7, 2026-10-15) and committed byte for byte.

- kokoro 0.9.4, misaki 0.9.4, `KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")`, PyTorch on CPU.
- Voice `af_heart`, speed 0.8085.
- Tokens came from `pipeline.g2p(spoken)`; the beat was then synthesized from those same tokens
  with `generate_from_tokens`, in one chunk.
- The file was byte-identical across two runs.

The generator read the beat from a words file outside this repository:

```python
pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
_, tokens = pipeline.g2p(beat["spoken"])
res = next(pipeline.generate_from_tokens(tokens, voice="af_heart", speed=beat["speed"]))
vocab = pipeline.model.vocab
ref = {
    "beat": beat["id"], "voice": "af_heart", "speed": beat["speed"], "ps": res.phonemes,
    "input_ids": [0, *[vocab[p] for p in res.phonemes if p in vocab], 0],
    "style_index": len(res.phonemes) - 1,
    "pred_dur": res.pred_dur.tolist(),
    "audio_samples": int(res.audio.shape[-1]),
    "tokens": [{"text": t.text, "phonemes": t.phonemes, "whitespace": t.whitespace,
                "start_ts": t.start_ts, "end_ts": t.end_ts} for t in res.tokens],
}
```

Run it with `python -I` and `HF_HUB_OFFLINE=1` against a pre-filled Hugging Face cache.

## Beats (S4)

`beats.golden.json` holds four more beats of our own explainer script (voice `af_heart`, each at
its script speed), recorded 2026-10-15. Its `header` names the producing versions: kokoro 0.9.4,
misaki 0.9.4, torch 2.14.1 (Python side), `@huggingface/transformers` 3.8.1 with
`onnxruntime-node` 1.21.0 on CPU at fp32 (TypeScript side).

Per beat: `tokens` (text, phonemes, whitespace, Python `start_ts`/`end_ts`), `ps`, `speed`,
`style_index`, `pred_dur` (Python's rounded frames), `raw_durations` (the TypeScript fp32 model's
unrounded `durations` output, stored as the shortest decimal that round-trips to fp32) and
`audio_samples`. `beats.golden.test.ts` checks `roundDurations(raw_durations)` equals `pred_dur`,
timings sit within 1 ms of Python's, and `sum(pred_dur) × 600 === audio_samples`.

| Beat | Role | Why it was chosen |
|---|---|---|
| `r3b-7-claim` | `near-half` | raw durations 2.50020 and 2.49996: one on each side of .5, so one frame rounds up and one down |
| `r6-1-seat` | `partial-oov` | `Titan-coord` is a rating-2 word; misaki keeps partial phonemes for it (`tˈItəŋkOˈɔɹd`) |
| `r3-1-nouns+null1` | `null-phoneme` | `r3-1-nouns` with the word `nouns` given `phonemes = None` before `generate_from_tokens`; Python times it as `""` and gives it `start_ts`/`end_ts` null |
| `r2-2-inv` | `long` | 224 phonemes, the longest beat of the script and still one chunk |

Findings that shaped the choice, from all 76 beats of the script run through both sides:

- No beat of the script has a null-phoneme word: misaki 0.9.4 with its Python lexicon gives every
  word phonemes. The null-phoneme beat is therefore a variant with one token blanked, not text
  from the script.
- No raw duration is below 0.5 (the smallest is 1.08), so the `clamp(min=1)` of
  `roundDurations` is never exercised by real data; the unit tests in `timestamps.test.ts` pin it.
- Two beats are **not** in the file because TypeScript fp32 and Python disagree by one frame on
  them: `r10-1-calls` (raw 4.49993 at frame 38, Python 5) and `r3-1-nouns` (raw 17.50013 at frame
  32, Python 17). Both are within 1.4e-4 of the rounding edge. Three beats sit within 5e-5 of the
  edge and agree (`r1-3-stores`, `r3b-7-claim`, `r4-3-open`). A swapped CPU or ORT version can
  flip a frame the same way, which is why the runtime frame-sum check exists.

Regenerate: run E7's `py_ref.py` over each beat with `python -I` (the kokoro 0.9.4 venv, model
cached), then a copy of E7's `e7.ts` that also writes `outputs.durations` as a plain array, with
the same tokens and the voice pack row `len(ps) - 1`. Keep the transformers cache and
`node_modules` in a scratch directory outside the repository and delete both afterwards.
