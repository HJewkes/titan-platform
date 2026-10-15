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
