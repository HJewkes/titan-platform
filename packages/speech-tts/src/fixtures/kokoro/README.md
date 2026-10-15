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

## Chunks (S3)

`chunks.golden.json` pins `chunk.ts` to Kokoro's 510-phoneme chunking. It was recorded on
2026-10-15 with kokoro 0.9.4 and misaki 0.9.4, using `KPipeline(lang_code="a", model=False)`, so no
model was loaded, and was byte-identical across two runs. The text is our own; the token lists are
misaki's `g2p` output for it.

Each case holds `tokens` as `[text, phonemes, whitespace]`, plus two lists of chunks as
`{ps, start, end}` token ranges: `en_tokenize` is `KPipeline.en_tokenize` itself, and `chunks` is
what `generate_from_tokens` synthesizes (empty chunks skipped, `ps` cut to 510).

| Case | What it covers |
|---|---|
| `short` | under 510 phonemes: one chunk |
| `split-at-period` | splits after the last `.` that leaves the rest within 510 |
| `no-punctuation` | none of `!.?…:;,—`, so `waterfall_last` falls through to every token |
| `bump` | the split lands on `.` and moves past the following `)` |
| `synthetic-truncation` | hand-built tokens: a 520-phoneme token that overflows an empty buffer (an empty `en_tokenize` chunk, then a cut to 510) and a null-phoneme token |
| `synthetic-lstrip` | hand-built tokens: a null-phoneme token that overflows on its space alone into an empty buffer, where `en_tokenize` drops that space from its count |

Regenerate with `python -I gen_chunks.py > chunks.golden.json` and `HF_HUB_OFFLINE=1`, in a
read-only venv that has kokoro 0.9.4 and misaki 0.9.4 (with spaCy's `en_core_web_sm`):

```python
import json
import sys
from importlib.metadata import version

from kokoro import KPipeline
from misaki.en import MToken

TEXTS = {
    "short": (
        "A quarter wave whip is about seventeen centimeters long at four hundred and forty megahertz."
    ),
    "split-at-period": (
        "Radio waves are ripples in the electric and magnetic fields that travel at the speed of light. "
        "Their length is the speed of light divided by the frequency, so a higher frequency means a shorter wave. "
        "An antenna works best when its size is a simple fraction of that length, such as a half or a quarter. "
        "A transmitter pushes current back and forth along the antenna, and the changing current launches a wave into space. "
        "A receiver does the reverse, turning a passing wave into a tiny current that an amplifier can boost. "
        "Between the two, the signal spreads out and grows weaker with every doubling of distance. "
        "Walls, trees and rain soak up some of it, while metal surfaces bounce it in new directions."
    ),
    "no-punctuation": (
        "the signal leaves the transmitter and travels through the coaxial cable to the antenna "
        "where the current flows up and down the metal rod and builds an electric field "
        "that pulls away from the rod and carries energy out into the room and across the street "
        "and over the hills until it reaches a receiving antenna that turns the passing field "
        "back into a small current which the receiver amplifies and filters and decodes "
        "so that the listener hears the same voice that spoke into the microphone many miles away "
        "even though nothing solid ever crossed the distance between the two towers"
    ),
    "bump": (
        "A coaxial cable keeps the signal inside a metal shield. "
        "The center wire carries the current out and the braid carries it back. "
        "Because the two currents are equal and opposite, their fields cancel outside the cable. "
        "That is why a good cable barely radiates at all. "
        "The space between the wire and the braid is filled with plastic foam, which sets how fast the wave moves. "
        "(Engineers call this ratio the velocity factor of the cable.) "
        "A long run of thin cable at a high frequency can waste most of the power before it ever reaches the antenna "
        "so the thick low loss kind is worth its price for any serious station on a tall mast"
    ),
}


SYNTHETIC = {
    "synthetic-truncation": [
        MToken(text="drone", tag="NN", whitespace=" ", phonemes="ə" * 520),
        MToken(text="hmm", tag="UH", whitespace=" ", phonemes=None),
        MToken(text="Hi", tag="UH", whitespace="", phonemes="hˈI"),
        MToken(text=".", tag=".", whitespace="", phonemes="."),
    ],
    # The second null token overflows on its space alone and lands in an empty buffer,
    # where en_tokenize lstrips it; without that the last token would split again.
    "synthetic-lstrip": [
        MToken(text="hum", tag="NN", whitespace=" ", phonemes="m" * 509),
        MToken(text="uh", tag="UH", whitespace=" ", phonemes=None),
        MToken(text="um", tag="UH", whitespace=" ", phonemes=None),
        MToken(text="buzz", tag="NN", whitespace="", phonemes="z" * 510),
    ],
}


def as_record(t):
    return [t.text, t.phonemes, t.whitespace]


def spans(groups):
    out, start = [], 0
    for ps, tks in groups:
        out.append({"ps": ps, "start": start, "end": start + len(tks)})
        start += len(tks)
    return out


def fresh(recorded):
    # en_tokenize rewrites None phonemes to "" in place, so each run gets its own copies.
    return [MToken(text=text, tag="", whitespace=ws, phonemes=ps) for text, ps, ws in recorded]


def record(pipeline, name, tokens):
    recorded = [as_record(t) for t in tokens]
    en = [(ps, tks) for _, ps, tks in pipeline.en_tokenize(fresh(recorded))]
    gen = [(r.phonemes, r.tokens) for r in pipeline.generate_from_tokens(fresh(recorded), voice=None)]
    print(name, len(recorded), "tokens", [len(ps) for ps, _ in en], file=sys.stderr)
    return {"name": name, "tokens": recorded, "en_tokenize": spans(en), "chunks": spans(gen)}


def main():
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=False)
    cases = [record(pipeline, name, pipeline.g2p(text)[1]) for name, text in TEXTS.items()]
    cases += [record(pipeline, name, tokens) for name, tokens in SYNTHETIC.items()]
    golden = {"kokoro": version("kokoro"), "misaki": version("misaki"), "cases": cases}
    print(dump(golden))


def dump(golden):
    lines = ["{", f' "kokoro": "{golden["kokoro"]}",', f' "misaki": "{golden["misaki"]}",', ' "cases": [']
    for c, case in enumerate(golden["cases"]):
        lines.append("  {")
        lines.append(f'   "name": {json.dumps(case["name"])},')
        for key in ("en_tokenize", "chunks"):
            rows = ",\n".join("    " + json.dumps(s, ensure_ascii=False) for s in case[key])
            lines.append(f'   "{key}": [\n{rows}\n   ],')
        rows = ",\n".join("    " + json.dumps(t, ensure_ascii=False) for t in case["tokens"])
        lines.append(f'   "tokens": [\n{rows}\n   ]')
        lines.append("  }" + ("," if c < len(golden["cases"]) - 1 else ""))
    lines += [" ]", "}"]
    return "\n".join(lines)


if __name__ == "__main__":
    main()
```

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
