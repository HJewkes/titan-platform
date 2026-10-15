# speech-vet fixtures

Golden data for the phone check (a port of the audiobook backend's `validation/phonemes.py`,
"AB"). Nothing in the package or its tests runs Python or espeak-ng: these files are
generated once, by the scripts below, and read as JSON. The repo is public, so **no
third-party text is committed**; see "Data rule".

| File | What |
|---|---|
| `espeak-ipa.golden.json` | `espeak-ng -q --ipa=3 -v <voice> <text>` stdout, verbatim, for every call AB's 34 test cases make (37 collected, one is 4-way parametrized). `entries` is the lookup table, `cases` maps each test name to the `[voice, text]` keys it uses. |
| `phones-replay.golden.json` | 30 owner-authored RF beats (Kokoro WAVs) plus 10 perturbed or constructed cases. Per case: `text`, `raw` (the recognizer's decode), `targets`, `unusual`, the recorded `espeak` output for the chunk and each target, and AB's three outputs under `expected`. |
| `ab-chunk-shingles.json` | Truncated sha256 of every 6-word shingle of the third-party chunks. Lets `fixtures.test.ts` reject a leak without holding the text. |
| `misaki-tokens.json` | Unrelated heteronym fixture. |

## Data rule

The out-of-repo AB replay (30 chunks of third-party fiction, plus AB's one 22-word quote
regression) lives in an out-of-repo bundle, `t8-ab-replay/cases.json`, next to the audio-spike
research notes. It is never committed. The quote case is represented here by a constructed
analogue (`analogue-duplicate-prefix`) that reaches the same `inconclusive` span guard.
The generator reads the quote from AB's test file at run time, so it is not in this README.

## Provenance

- AB at `b13d8acbedfc280b805422dfde84f1e36d0b3bac` (read-only), the model
  `facebook/wav2vec2-lv-60-espeak-cv-ft` (PyTorch, CPU, fp32), espeak-ng 1.52.0, voice `en-us`.
- Run in AB's own virtualenv with `python -I`, `HF_HUB_OFFLINE=1`, `CUDA_VISIBLE_DEVICES=`
  and `PYTHONDONTWRITEBYTECODE=1`, from `<AB>/backend`. Nothing is downloaded.
- The raw decode is `_recognize_raw(load_slice(wav))`, never `recognize_wav`, so AB's phoneme
  cache is not written.
- Targets and `unusual` are built as `scripts/scan_defects.py` builds them.
- Perturbed cases re-score a beat's own raw string or its per-word espeak phones with one
  edit: inserted babble (`hallucination`), an appended stray (`tail`), a garbled word
  (`xtts`), a weak form (`weakForm`), an unusual word between 0.45 and 0.70 (`unusualOverride`,
  with `plain` holding the verdicts without the override). Each carries `tags`.

## Generators

Save each script below under its heading's name and run them in this order. `AB` is the
audiobook checkout, `BEATS` the directory with the RF beats' `words.json` and WAVs, `E6`
the spike's results directory (`manifest.json`, `verdicts.json`), `T` a scratch directory.

```sh
cd "$AB/backend"
PY="$AB/venv-cu128/bin/python"
export PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 CUDA_VISIBLE_DEVICES=
"$PY" -I record_cases.py "$AB" "$T/cases.json"
"$PY" -I recognize_rf.py "$AB" "$BEATS" "$T/rf_raw.json"
"$PY" -I build_replay.py "$AB" "$T/rf_raw.json" "$E6" "$T/phones-replay.golden.json" "$T/bundle"
python3 -I finalize.py "$T/cases.json" "$T/phones-replay.golden.json" "$T/bundle/cases.json" <fixtures dir>
```

### record_cases.py

Runs AB's own test file with `subprocess.run` wrapped, attributing each espeak call to its test.

```python
"""Run AB's test_phonemes.py with every espeak-ng call recorded, per test.

Usage: python -I record_cases.py <audiobook root> <out.json>
"""
import json
import subprocess
import sys
from pathlib import Path

ab, out = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(ab / "backend"))

import pytest  # noqa: E402
from src.validation import phonemes as ph  # noqa: E402

current = {"id": None}
per_case: dict = {}
real_run = subprocess.run


def recording_run(argv, *a, **kw):
    res = real_run(argv, *a, **kw)
    if argv and argv[0] == "espeak-ng" and current["id"]:
        # argv is ["espeak-ng", "-q", "--ipa=3", "-v", voice, text]
        assert argv[1:4] == ["-q", "--ipa=3", "-v"], argv
        per_case.setdefault(current["id"], []).append(
            {"voice": argv[4], "text": argv[5], "ipa": res.stdout})
    return res


ph.subprocess.run = recording_run


class Recorder:
    def pytest_runtest_setup(self, item):
        current["id"] = item.name

    def pytest_runtest_teardown(self, item):
        current["id"] = None


code = pytest.main([str(ab / "backend/tests/test_phonemes.py"), "-q", "-p", "no:cacheprovider",
                    "--rootdir", str(ab / "backend")], plugins=[Recorder()])
out.write_text(json.dumps({"exit": int(code), "perCase": per_case}, ensure_ascii=False, indent=1))
print("pytest exit", int(code), "cases with espeak:", len(per_case))
```

### recognize_rf.py

```python
"""Recognize the RF beat WAVs with AB's own PhonemeRecognizer (raw decode, no cache write).

Usage: python -I recognize_rf.py <audiobook root> <beats dir (with words.json and *.wav)> <out.json>
"""
import json
import sys
from pathlib import Path

ab, beats_dir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
sys.path.insert(0, str(ab / "backend"))

from src.validation import phonemes as ph  # noqa: E402

rec = ph.PhonemeRecognizer.__new__(ph.PhonemeRecognizer)  # skips the cache-dir mkdir in __init__
rec.model_name, rec._model, rec._processor = ph.PHONEME_MODEL, None, None
rec._load()
beats = json.loads((beats_dir / "words.json").read_text())["beats"]
rows = []
for b in beats:
    wav = beats_dir / f"{b['id']}.wav"
    if not wav.exists() or not b.get("spoken"):
        continue
    raw = rec._recognize_raw(ph.load_slice(wav, None, None))
    rows.append({"id": b["id"], "text": b["spoken"], "raw": raw})
out.write_text(json.dumps(rows, ensure_ascii=False, indent=1))
print(len(rows), "beats recognized; model", ph.PHONEME_MODEL)
```

### build_replay.py

Writes the RF replay and the out-of-repo bundle in one pass, so both come from the same
scoring code. It also re-scores the E6 chunks and reports any that differ from AB's recorded
`verdicts.json` (the run that produced these files reported none).

```python
"""Score cases with AB's unchanged verdict functions, recording every espeak-ng call.

Usage: python -I build_replay.py <audiobook root> <rf_raw.json> <e6 dir> <rf out.json> <bundle dir>
"""
import ast
import json
import subprocess
import sys
from pathlib import Path

ab, rf_raw, e6, rf_out, bundle = map(Path, sys.argv[1:6])
sys.path.insert(0, str(ab / "backend"))

from src.validation import phonemes as ph  # noqa: E402
from src.validation.defects import is_unusual_word, tokenize  # noqa: E402

VOICE = "en-us"
MIN_TARGET_LEN = 3  # scripts/scan_defects.py, as in E6 compare.py
real_run = subprocess.run
calls: dict = {}


def recording_run(argv, *a, **kw):
    res = real_run(argv, *a, **kw)
    assert argv[:4] == ["espeak-ng", "-q", "--ipa=3", "-v"] and argv[4] == VOICE, argv
    calls[argv[5]] = res.stdout
    return res


ph.subprocess.run = recording_run


def chunk_targets(text):
    seen, words = set(), []
    for tok in tokenize(text):
        if tok.norm in seen or tok.norm.startswith("#") or len(tok.norm) < MIN_TARGET_LEN:
            continue
        seen.add(tok.norm)
        words.append(tok.original)
    return words


def score(text, raw, targets=None, unusual="auto"):
    targets = chunk_targets(text) if targets is None else targets
    if unusual == "auto":
        unusual = [w for w in targets if is_unusual_word(w)]
    calls.clear()
    out = {"words": ph.chunk_word_verdicts(text, raw, targets=targets, unusual=set(unusual)),
           "halluc": ph.detect_hallucinations(text, raw),
           "tail": ph.detect_tail_artifact(text, raw)}
    return {"text": text, "raw": raw, "targets": targets, "unusual": unusual,
            "espeak": dict(calls), "expected": out}


def parts_of(text):
    parts = ph.g2p_sentence(text, VOICE)
    return parts if len(parts) == len(text.split()) else None


def strip(w):
    return w.strip(".,!?;:\"'()[]…—-")


def find_garble(beats):
    for b in beats:
        parts = parts_of(b["text"])
        if not parts:
            continue
        for k, w in enumerate(b["text"].split()):
            if len(strip(w)) < 5 or is_unusual_word(strip(w)):
                continue
            p = list(parts)
            p[k] = "zzzzxq"
            c = score(b["text"], "".join(p), targets=[strip(w)], unusual=[])
            if c["expected"]["words"] and c["expected"]["words"][0]["source"] == "xtts":
                return b, "".join(p)
    raise SystemExit("no garble candidate")


def find_weak(beats):
    for b in beats:
        parts = parts_of(b["text"])
        if not parts:
            continue
        for k, w in enumerate(b["text"].split()):
            weak = ph._WEAK_FORMS.get(strip(w).lower())
            if not weak:
                continue
            p = list(parts)
            p[k] = weak[0]
            c = score(b["text"], "".join(p), targets=[strip(w)], unusual=[])
            v = c["expected"]["words"][0] if c["expected"]["words"] else None
            if v and v["distance"] == 0.0 and v["expected_phones"] == ph.clean_ipa(weak[0]) \
                    and v["expected_phones"] != ph.clean_ipa(ph.g2p(strip(w), VOICE)):
                return b, "".join(p)
    raise SystemExit("no weak candidate")


def find_unusual(beats):
    for b in beats:
        parts = parts_of(b["text"])
        if not parts:
            continue
        for k, w in enumerate(b["text"].split()):
            sw = strip(w)
            if not is_unusual_word(sw) or len(ph.clean_ipa(ph.g2p(sw, VOICE))) < 5:
                continue
            cite = parts[k]
            for n in range(1, len(cite)):
                p = list(parts)
                p[k] = cite[:-n] + "z" * n
                plain = score(b["text"], "".join(p), targets=[sw], unusual=[])
                tagged = score(b["text"], "".join(p), targets=[sw], unusual=[sw])
                pw, tw = plain["expected"]["words"], tagged["expected"]["words"]
                if pw and tw and pw[0]["source"] == "xtts" and tw[0]["source"] == "whisper":
                    tagged["plain"] = pw
                    return b, tagged
    raise SystemExit("no unusual candidate")


ANALOGUE_TEXTS = [
    "If I benched Jo Jofar, Rovers would be short of options. "
    "Two games, if we were being honest.",
]


def find_inconclusive():
    """Reproduce the _index_map collapse: a near-duplicate prefix before the target."""
    for text in ANALOGUE_TEXTS:
        words = text.split()
        parts = ph.g2p_sentence(text, VOICE)
        if len(parts) != len(words):
            continue
        k = words.index("Jofar,")
        dup, tgt = parts[k - 1], parts[k]
        for drop in range(0, len(tgt) + 1):
            for variant in (dup + tgt[1:], dup[:-1] + tgt, dup + tgt[drop:], dup + tgt[:drop]):
                p = list(parts)
                p[k - 1:k + 1] = [variant]
                for tail_cut in (0, 2, 4):
                    q = list(p)
                    q[k + 1] = q[k + 1][tail_cut:]
                    c = score(text, "".join(q), targets=["Jofar"], unusual=[])
                    w = c["expected"]["words"]
                    if w and w[0]["source"] == "inconclusive":
                        return c
    raise SystemExit("no inconclusive candidate")


def main():
    rf = json.loads(rf_raw.read_text())
    beats = [b for b in rf if b["text"].strip()][:30]
    cases = []
    for b in beats:
        c = score(b["text"], b["raw"])
        cases.append({"id": b["id"], "origin": "rf-beat", **c})
    pool = beats
    perturbed = []

    def add(name, tags, base, c):
        perturbed.append({"id": f"{base}+{name}", "origin": "perturbed", "tags": tags, **c})

    by_id = {b["id"]: b for b in beats}
    for i, b in enumerate(beats[:3]):
        toks = b["raw"].split()
        mid = len(toks) // 2
        babble = toks[:mid] + "w ʌ n ʃ ɹ i".split() + toks[mid:]
        add(f"babble{i}", ["hallucination"], b["id"], score(b["text"], " ".join(babble)))
    for i, (b, stray) in enumerate([(beats[3], "tʃ ə"), (beats[4], "t"), (beats[5], "k u")]):
        add(f"tail{i}", ["tail"], b["id"], score(b["text"], b["raw"] + " " + stray))
    b, raw = find_garble(pool)
    add("garbled", ["xtts"], b["id"], score(b["text"], raw, targets=[strip(w) for w in b["text"].split() if len(strip(w)) >= 5][:6], unusual=[]))
    b, raw = find_weak(pool)
    c = score(b["text"], raw)
    add("weak-form", ["weakForm"], b["id"], c)
    b, c = find_unusual(pool)
    add("unusual", ["unusualOverride"], b["id"], c)
    perturbed[-1]["plain"] = c.pop("plain") if "plain" in c else perturbed[-1].get("plain")
    ana = find_inconclusive()
    perturbed.append({"id": "analogue-duplicate-prefix", "origin": "constructed",
                      "tags": ["inconclusive"], **ana})

    header = {"_source": {
        "audiobookSha": "b13d8acbedfc280b805422dfde84f1e36d0b3bac",
        "model": ph.PHONEME_MODEL, "espeakVersion": "1.52.0", "voice": VOICE,
        "rawDecode": "PhonemeRecognizer._recognize_raw(load_slice(wav)), never recognize_wav",
        "verdicts": "AB chunk_word_verdicts, detect_hallucinations, detect_tail_artifact, unchanged",
        "beats": "redesign-explainer-v4 audio, owner-authored Kokoro beats",
    }}
    rf_out.write_text(json.dumps({**header, "cases": cases + perturbed}, ensure_ascii=False, indent=1))
    print("rf", len(cases), "perturbed", len(perturbed))
    write_bundle()


def write_bundle():
    manifest = json.loads((e6 / "manifest.json").read_text())
    verdicts = json.loads((e6 / "verdicts.json").read_text())
    entries, bad = [], []
    for m in manifest:
        text = Path(m["txt"]).read_text()
        pt = verdicts[f"pt/{m['id']}"]
        c = score(text, pt["raw"])
        if c["expected"] != pt["v"]:
            bad.append(m["id"])
        entries.append({"id": m["id"], "kind": m["kind"], "txt": m["txt"], **c,
                        "abVerdicts": pt["v"]})
    tree = ast.parse((ab / "backend/tests/test_phonemes.py").read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
              and n.name == "test_degenerate_span_from_duplicate_prefix_is_inconclusive_not_xtts")
    quoted = {t.targets[0].id: ast.literal_eval(t.value) for t in fn.body
              if isinstance(t, ast.Assign) and getattr(t.targets[0], "id", None) in ("text", "actual")}
    ok = score(quoted["text"], quoted["actual"], targets=[quoted["text"].split()[5].rstrip(",")], unusual=[])
    entries.append({"id": "ab-regression-duplicate-prefix", "kind": "ab-test-regression", **ok})
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "cases.json").write_text(json.dumps({
        "audiobookSha": "b13d8acbedfc280b805422dfde84f1e36d0b3bac", "espeakVersion": "1.52.0",
        "voice": VOICE, "model": ph.PHONEME_MODEL, "cases": entries}, ensure_ascii=False, indent=1))
    print("bundle", len(entries), "AB verdicts.json mismatches:", bad)


main()
```

### finalize.py

```python
"""Assemble the committed espeak recordings and the third-party shingle deny list.

Usage: python -I finalize.py <cases.json> <replay golden> <bundle cases.json> <fixtures dir>
"""
import hashlib
import json
import re
import sys
from pathlib import Path

cases_p, replay_p, bundle_p, out = map(Path, sys.argv[1:5])
DUPLICATE_PREFIX_TEST = "test_degenerate_span_from_duplicate_prefix_is_inconclusive_not_xtts"
ANALOGUE_ID = "analogue-duplicate-prefix"
SHINGLE = 6
TOKEN = re.compile(r"[^\W_]+(?:'[^\W_]+)*")


def shingles(text):
    toks = TOKEN.findall(text.lower().replace("’", "'"))
    return {hashlib.sha256(" ".join(toks[i:i + SHINGLE]).encode()).hexdigest()[:12]
            for i in range(len(toks) - SHINGLE + 1)}


recorded = json.loads(cases_p.read_text())
replay = json.loads(replay_p.read_text())
analogue = next(c for c in replay["cases"] if c["id"] == ANALOGUE_ID)
per_case = {k: [(r["voice"], r["text"], r["ipa"]) for r in v] for k, v in recorded["perCase"].items()}
per_case[DUPLICATE_PREFIX_TEST] = [("en-us", t, ipa) for t, ipa in analogue["espeak"].items()]

entries, cases = {}, {}
for name, rows in per_case.items():
    cases[name] = [[v, t] for v, t, _ in rows]
    for v, t, ipa in rows:
        entries[(v, t)] = ipa
header = {"audiobookSha": "b13d8acbedfc280b805422dfde84f1e36d0b3bac", "espeakVersion": "1.52.0",
          "command": "espeak-ng -q --ipa=3 -v <voice> <text>, stdout verbatim",
          "recordedFrom": "backend/tests/test_phonemes.py, every espeak-ng call per test",
          "note": f"{DUPLICATE_PREFIX_TEST} is recorded against the constructed analogue, not AB's quote"}
(out / "espeak-ipa.golden.json").write_text(json.dumps({
    "_source": header,
    "entries": [{"voice": v, "text": t, "ipa": i} for (v, t), i in sorted(entries.items())],
    "cases": cases}, ensure_ascii=False, indent=1) + "\n")

deny = set()
for c in json.loads(bundle_p.read_text())["cases"]:
    deny |= shingles(c["text"])
(out / "ab-chunk-shingles.json").write_text(json.dumps({
    "_note": f"sha256 prefixes (12 hex) of {SHINGLE}-word shingles of the third-party chunks; "
             "lets CI reject a leak without holding the text",
    "shingle": SHINGLE, "hashes": sorted(deny)}, indent=0) + "\n")
(out / "phones-replay.golden.json").write_text(replay_p.read_text().rstrip("\n") + "\n")
print(len(entries), "espeak entries,", len(cases), "cases,", len(deny), "shingles")
```


## Defects (TP-3036 T9)

Golden data for the defects check (a port of AB's `validation/defects.py`) and its in-package
metaphone (a port of jellyfish's). Like the phone check's, these files are generated once and read
as JSON; no test runs Python.

| File | What |
|---|---|
| `defects.golden.json` | 60 constructed `detectDefects` cases, 8 `confirmDefects` cases and 26 `scanNumber` rows. Each case holds the `transcript` (speech-stt `Transcript` shape), and AB's output in two records: `on`, the full transcript, and `off`, the same call with every word `probability` removed and `segments` emptied. Defects are raw dataclass fields in camelCase, `severity` unrounded, `None` left out. `scanNumber` values are decimal strings. |
| `metaphone.golden.json` | 200 words with `jellyfish.metaphone` codes (jellyfish 1.2.1, Rust build): 60 hand-picked rule words, 36 words ending `-mb`, `-gn` and `-gh` (where Rust and jellyfish's Python fallback differ), the words the defects golden passes to the phonetic distance, 6 edge strings, and a fixed-stride sample of lowercase dictionary headwords. `allowedDifferences` is empty. |

The AB inputs of `test_defects.py` are ported as `ab-*` cases. One is replaced: AB's elongation
input may be stylised book text, so `ab-count-mismatch-groups-into-single-defect` uses the
constructed analogue `Heeeeeelp Vela spoke` heard as `Hell P vella spoke`. The citation in AB's ASAP
test docstring is not carried over.

### Data rule (defects)

Every string is constructed or a lowercase dictionary headword. Nothing comes from AB's books, chunk
WAVs, `data/test_set`, the pronunciation lexicon or E1's raw results. Each constructed word was
checked with `grep -rIiwl <word> <AB>/data/books` (counts only): zero hits. `defects-fixtures.test.ts`
enforces the shingle deny list, the `[a-zſ0-9']` word pattern, the capitalisation allow-list
(`Vela`, `ASAP`) and a 100 KB budget.

### Provenance (defects)

- AB at `b13d8acbedfc280b805422dfde84f1e36d0b3bac`, read-only; its `defects.py` is loaded unchanged by
  path. jellyfish 1.2.1 (Rust build) and Python 3.12, from AB's `venv-cu128`.
- Run with `python -I`, `PYTHONDONTWRITEBYTECODE=1`, from an empty scratch directory. The scripts
  set `sys.dont_write_bytecode`, since `-I` ignores the environment variable.
- `gen_defects.py` runs first: it also writes `phonetic-inputs.json` (every string the golden passes
  to `jellyfish.metaphone`) into the scratch directory for `gen_metaphone.py`.
- Arguments: `gen_defects.py <AB>/backend <fixtures dir> <scratch>`;
  `gen_metaphone.py <misaki us_gold.json> <scratch>/phonetic-inputs.json <fixtures dir> <sweep.json>`.
- `gen_metaphone.py` also writes the full sweep (every lowercase `us_gold` headword plus the golden
  words, with codes) to `sweep.json`, kept out of the repo for size.

### gen_defects.py

```python
import dataclasses
import importlib.util
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ab, out, scratch = (Path(a) for a in sys.argv[1:4])
import jellyfish

spec = importlib.util.spec_from_file_location("ab_defects", ab / "src" / "validation" / "defects.py")
mod = importlib.util.module_from_spec(spec)
sys.modules["ab_defects"] = mod
spec.loader.exec_module(mod)

phonetic_inputs = []


class Recorder:
    @staticmethod
    def metaphone(word):
        phonetic_inputs.append(word)
        return jellyfish.metaphone(word)

    levenshtein_distance = staticmethod(jellyfish.levenshtein_distance)


mod.jellyfish = Recorder


def transcript(pairs, segments=None, text=None):
    words = []
    for i, pair in enumerate(pairs):
        w, p = (pair, 0.95) if isinstance(pair, str) else pair
        words.append({"text": w, "start": i * 0.5, "end": i * 0.5 + 0.4, "probability": p})
    return {"text": text if text is not None else " ".join(w["text"] for w in words),
            "words": words, "segments": segments or []}


def seg(start, end, text, logprob=None, ratio=None):
    s = {"text": text, "start": start, "end": end, "noSpeechProb": 0.01}
    if logprob is not None:
        s["avgLogprob"] = logprob
    if ratio is not None:
        s["compressionRatio"] = ratio
    return s


def heard(sentence, prob=0.95, **override):
    return transcript([(w, override.get(w, prob)) for w in sentence.split()])


def to_ab(t):
    words = [{"word": w["text"], "start": w["start"], "end": w["end"],
              **({"probability": w["probability"]} if "probability" in w else {})} for w in t["words"]]
    segs = [{"text": s["text"], "start": s["start"], "end": s["end"],
             **{snake: s[camel] for camel, snake in
                (("avgLogprob", "avg_logprob"), ("compressionRatio", "compression_ratio"),
                 ("noSpeechProb", "no_speech_prob")) if camel in s}} for s in t["segments"]]
    return {"text": t["text"], "words": words, "segments": segs}


def stripped(t):
    return {"text": t["text"], "segments": [],
            "words": [{k: v for k, v in w.items() if k != "probability"} for w in t["words"]]}


def dump(defect):
    raw = dataclasses.asdict(defect)
    camel = {"audio_start": "audioStart", "audio_end": "audioEnd"}
    return {camel.get(k, k): v for k, v in raw.items() if v is not None}


def detect(expected, t):
    return [dump(d) for d in mod.detect_defects(expected, to_ab(t))]


def confirm(expected, base, strong):
    found = mod.detect_defects(expected, to_ab(base))
    return [dump(d) for d in mod.confirm_defects(found, expected, to_ab(strong))]


cases, confirms = [], []


def case(id, tags, expected, t):
    cases.append({"id": id, "tags": tags, "expected": expected, "transcript": t,
                  "on": detect(expected, t), "off": detect(expected, stripped(t))})


def confirm_case(id, tags, expected, base, strong):
    confirms.append({"id": id, "tags": tags, "expected": expected, "base": base, "confirm": strong,
                     "on": confirm(expected, base, strong),
                     "off": confirm(expected, stripped(base), stripped(strong))})


# AB's test inputs (test_defects.py at the pinned sha), minus the one that may be book text
case("ab-confident-homophone", ["one-to-one"], "they left their house",
     transcript([("they", .99), ("left", .98), ("there", .97), ("house", .98)]))
case("ab-digit-spoken-as-word", ["digit-as-word", "one-to-one"], "chapter 50 begins",
     transcript([("chapter", .98), ("fifty", .95), ("begins", .97)]))
case("ab-real-number-mangle", ["one-to-one"], "chapter 50 begins",
     transcript([("chapter", .98), ("fifteen", .6), ("begins", .97)]))
case("ab-mangled-word-low-confidence-boost", ["one-to-one"], "the aegis protected them",
     transcript([("the", .99), ("eejis", .3), ("protected", .96), ("them", .95)]))
case("ab-count-mismatch-groups-into-single-defect", ["grouped"], "Heeeeeelp Vela spoke",
     transcript([("Hell", .5), ("P", .2), ("vella", .5), ("spoke", .95)]))
case("ab-low-confidence-segment-with-aligned-words", ["logprob"], "the empire stood firm",
     transcript([("the", .9), ("empire", .9), ("stood", .9), ("firm", .9)],
                [{"start": 0.0, "end": 2.0, "text": "the empire stood firm", "avgLogprob": -1.6,
                  "compressionRatio": 1.4, "noSpeechProb": 0.01}]))
case("ab-defects-sorted-by-severity", ["one-to-one"], "the aegis of the foobarbaz empire",
     transcript([("the", .99), ("eejis", .3), ("of", .98), ("the", .98), ("zorptrix", .2), ("empire", .97)]))
case("ab-multiword-number-spoken-correctly", ["digit-as-word"], "he owed 250 gold",
     transcript([("he", .99), ("owed", .98), ("two", .9), ("hundred", .9), ("fifty", .9), ("gold", .97)]))
case("ab-letter-read-as-its-name", ["letter-name"], "grade C was fine",
     transcript([("grade", .98), ("see", .9), ("was", .97), ("fine", .97)]))
case("ab-last-word-is-chunk-boundary", ["one-to-one"], "she needs the report ASAP.",
     transcript([("she", .98), ("needs", .97), ("the", .98), ("report", .96), ("zorptrix", .4)]))
ab_base = transcript([("the", .99), ("eejis", .3), ("protected", .96), ("them", .95)])
ab_strong = transcript([("the", .99), ("eejit", .6), ("protected", .98), ("them", .98)])
confirm_case("ab-confirm-keeps-agreed-defect", [], "the aegis protected them", ab_base, ab_strong)
confirm_case("ab-confirm-drops-base-only-false-positive", [], "she left the house",
             transcript([("he", .4), ("left", .9), ("the", .9), ("house", .9)]),
             transcript([("she", .95), ("left", .98), ("the", .98), ("house", .98)]))
confirm_case("ab-confirm-empty-when-no-base-defects", [], "clean audio",
             transcript([("clean", .99), ("audio", .99)]), transcript([("clean", .99), ("audio", .99)]))

# omissions
case("omit-stopword-only", ["stopword-omission"], "she walked to the door", heard("she walked the door"))
case("omit-single-content-word", [], "the tall guard slept", heard("the guard slept"))
case("omit-two-content-words", ["multi-content-omission"], "we crossed the wide cold river",
     heard("we crossed the river"))
case("omit-number", [], "pay 40 coins now", heard("pay coins now"))
case("omit-at-tail", [], "the gate stayed shut tonight", heard("the gate stayed shut"))

# substitutions
case("sub-one-to-one-low-probability", ["one-to-one"], "the zorptrix fled", heard("the corpus fled", .4))
case("sub-unrelated-word-caps-severity", ["one-to-one"], "a quiet river ran", heard("a quiet bucket ran", .05))
case("sub-unusual-word", ["one-to-one"], "then Vela arrived late today", heard("then bela arrived late today", .6))
case("sub-chunk-head-boundary", ["one-to-one"], "zorptrix fled the keep at dawn", heard("corpus fled the keep at dawn"))
case("sub-low-probability-homophone", ["low-prob-homophone", "one-to-one"], "they left their house",
     heard("they left there house", there=.3))
case("sub-confident-homophone-borderline", ["one-to-one"], "they left their house",
     heard("they left there house", there=.45))
case("grouped-three-to-two", ["grouped"], "an inquisitive wombat sat down", heard("an inquisitive wombats down"))
case("grouped-low-probability-boost", ["grouped"], "the old oak tree fell", heard("the notoak tree fell", .2))
case("grouped-homophone-merge", ["grouped"], "any one of them", heard("anyone of them"))
case("grouped-many-to-one", ["grouped"], "walk the long road home", heard("walk the lonroad home"))
case("grouped-carries-causes-sorted", ["grouped"], "pay 40 zorptrix coins", heard("pay for tricks coins"))
case("elongation-aligns-with-clean-speech", [], "tiiiired tonight", heard("tired tonight"))
case("elongation-one-to-one-defect", ["one-to-one"], "pleeease stop now", heard("police stop now", .6))
case("curly-apostrophe-splits-token", ["grouped"], "we don’t go", heard("we don't go"))
case("hyphen-splits-into-two-tokens", ["trap:T7"], "a well-known road", heard("a well known road"))
case("hyphen-mangle-has-no-smushed-cause", ["trap:T7", "one-to-one"], "a well-known road", heard("a wall known road", .5))

# numbers
case("three-hundred-twelve", ["three-hundred-twelve", "digit-as-word"], "room 312 is locked",
     heard("room three hundred twelve is locked"))
case("three-hundred-twelve-mangled", [], "room 312 is locked", heard("room three hundred ten is locked", .5))
case("one-thirty-six", ["one-thirty-six"], "see 1 36 on the map", heard("see one thirty six on the map"))
case("seven-thousand-two-hundred-fifty", ["digit-as-word"], "it cost 7250 coins",
     heard("it cost seven thousand two hundred fifty coins"))
case("zero-zero", ["zero-zero"], "code 0 0 reset", heard("code zero zero reset"))
case("and-stops-the-number", ["number-and-stop"], "she paid 520 coins", heard("she paid five hundred and twenty coins"))
case("twenty-digit-numbers-differ", ["trap:T6", "one-to-one"], "tag 12345678901234567890 done",
     heard("tag 12345678901234567891 done"))
case("leading-zeros-equal", ["digit-as-word"], "gate 007 opened", heard("gate 7 opened"))
case("digit-heard-for-number-word", ["digit-as-word"], "seven men rode", heard("7 men rode"))
case("letter-read-as-wrong-name", ["letter-name", "one-to-one"], "grade C was fine", heard("grade bee was fine", .8))

# low confidence segments
case("segment-low-logprob", ["logprob"], "the dragon slept",
     transcript(["the", "dragon", "slept"], [seg(0.0, 1.5, "the dragon slept", logprob=-1.2)]))
case("segment-high-compression-ratio", ["compression-ratio"], "the dragon slept",
     transcript(["the", "dragon", "slept"], [seg(0.0, 1.5, "the dragon slept", logprob=-0.4, ratio=3.0)]))
case("segment-logprob-bonus-capped", ["logprob"], "the dragon slept",
     transcript(["the", "dragon", "slept"], [seg(0.0, 1.5, "the dragon slept", logprob=-2.0)]))
case("segment-already-covered", ["segment-covered"], "the dragon slept",
     transcript(["the", ("dragan", .9), "slept"], [seg(0.5, 1.5, "the dragan slept", logprob=-1.3)]))
heard_t3 = transcript(["the", "dragan", "slept"])
heard_t3["words"][0].update(start=0.0, end=0.2)
heard_t3["words"][1].update(start=0.25, end=0.6)
heard_t3["words"][2].update(start=0.7, end=1.0)
heard_t3["segments"] = [seg(0.2, 0.6, "dragan", logprob=-1.4), seg(0.9, 1.2, "slept", logprob=-1.4)]
case("segment-start-rounds-half-even", ["trap:T3", "segment-covered"], "the dragon slept", heard_t3)
case("segment-not-flagged-when-confident", [], "the dragon slept",
     transcript(["the", "dragon", "slept"], [seg(0.0, 1.5, "the dragon slept", logprob=-0.3, ratio=1.2)]))

# text-only and degenerate transcripts
case("text-only-fallback", ["text-only"], "the dragon slept",
     {"text": "the dragan slept", "words": [], "segments": []})
case("text-only-with-numbers", ["text-only"], "pay 40 coins now",
     {"text": "pay forty coins now", "words": [], "segments": []})
case("punctuation-only-words-fall-back-to-text", ["text-only"], "the dragon slept",
     {"text": "the dragan slept", "words": [{"text": "...", "start": 0.0, "end": 0.4}], "segments": []})
case("heard-words-carry-punctuation", [], "the dragon slept near",
     transcript(["the", "dragan,", "slept.", "near"]))

# traps
case("tie-severities-keep-input-order", ["trap:T4", "one-to-one"], "red fox and blue owl",
     heard("bed fox and glue owl"))
case("tie-three-way", ["trap:T4", "one-to-one"], "red fox and blue owl and green fin",
     heard("bed fox and glue owl and green fan"))
case("long-s-tokenizes-as-a-letter", ["trap:T1", "one-to-one"], "ſtop the car", heard("stop the car"))
case("kelvin-sign-tokenizes-as-a-letter", ["trap:T1"], "Keep the gate", heard("keep the gate"))
case("emoji-before-final-word", ["trap:T2", "one-to-one"],
     "\U0001f600 the old gate fell near zorptrix\U0001f600\U0001f600", heard("the old gate fell near corpus"))
case("emoji-shifts-context-window", ["trap:T2", "one-to-one"],
     "\U0001f600" * 10 + " they walked a long way past the old mill and the zorptrix stood by the gate until night fell",
     heard("they walked a long way past the old mill and the corpus stood by the gate until night fell"))
case("control-separator-in-context", ["trap:T5", "one-to-one"],
     "the dragon\x1fslept near the zorptrix gate", heard("the dragon slept near the corpus gate"))
case("control-separator-at-window-edge", ["trap:T5", "one-to-one"],
     "\x1f\x1fthe zorptrix fled\x1f", heard("the corpus fled"))

# a chunk past 200 heard tokens, so difflib's autojunk heuristic is live
vocab = "the old dog saw a small cat near the red barn and the pale moon rose over a quiet hill".split()
long_words = [vocab[i % len(vocab)] for i in range(210)]
long_heard = list(long_words)
long_heard[40], long_heard[120] = "hog", "carn"
del long_heard[170], long_heard[60]
case("long-chunk-autojunk", ["autojunk"], " ".join(long_words), heard(" ".join(long_heard)))

# confirm
lowseg = [seg(0.0, 1.5, "the dragon slept", logprob=-1.5)]
confirm_case("confirm-keeps-low-confidence-window", [], "the dragon slept",
             transcript(["the", "dragon", "slept"], lowseg),
             transcript(["the", "dragon", "slept"], [seg(0.2, 1.4, "the dragon slept", logprob=-1.5)]))
confirm_case("confirm-drops-low-confidence-outside-window", [], "the dragon slept",
             transcript(["the", "dragon", "slept"], lowseg),
             transcript(["the", "dragon", "slept"], [seg(3.0, 4.0, "the dragon slept", logprob=-1.5)]))
confirm_case("confirm-stopword-only-falls-back-to-all-tokens", [], "the a",
             transcript([("an", .3), ("to", .3)]), transcript([("an", .3), ("to", .3)]))
confirm_case("confirm-omission-both-models", [], "we crossed the wide cold river",
             heard("we crossed the river"), heard("we crossed the river"))
confirm_case("confirm-severity-comes-from-the-stronger-model", [], "the zorptrix fled",
             heard("the corpus fled", .3), heard("the corpus fled", .9))

numbers = [(["two", "hundred", "fifty"], 0), (["one", "hundred", "forty", "nine"], 0), (["thirty", "three"], 0),
           (["50"], 0), (["one", "thirty", "six"], 0), (["one", "thirty", "six"], 1),
           (["seven", "thousand", "two", "hundred", "fifty"], 0), (["house"], 0),
           (["three", "hundred", "twelve"], 0), (["five", "hundred", "and", "twenty"], 0),
           (["zero", "zero"], 0), (["zero", "zero"], 1), (["twelve", "hundred"], 0), (["hundred"], 0),
           (["one", "hundred", "hundred"], 0), (["two", "million", "three", "thousand", "four"], 0),
           (["seven", "eight"], 0), (["twenty", "one"], 0), (["twenty", "ten"], 0), (["ten", "five"], 0),
           (["thousand"], 0), (["one", "thousand", "thousand"], 0), (["007"], 0),
           (["12345678901234567890"], 0), (["go", "fifty", "fifty"], 1), (["sixty", "nine", "nine"], 0)]
scan = []
for norms, i in numbers:
    value, end = mod._scan_number(norms, i)
    scan.append({"norms": norms, "i": i, "value": None if value is None else str(value), "end": end})

assert not [d for d in cases[[c["id"] for c in cases].index("three-hundred-twelve")]["on"]], "312 must align"
vela = next(c for c in cases if c["id"].startswith("ab-count-mismatch"))
assert len(vela["on"]) == 1 and "stylized_elongation" in vela["on"][0]["causes"], vela["on"]
for tie in ("tie-severities-keep-input-order", "tie-three-way"):
    sev = [d["severity"] for d in next(c for c in cases if c["id"] == tie)["on"]]
    assert len(sev) != len(set(sev)), (tie, sev)
for c in cases:
    assert all(d["kind"] != "insertion" for d in c["on"] + c["off"])

header = {"audiobookSha": "b13d8acbedfc280b805422dfde84f1e36d0b3bac", "python": "3.12", "jellyfish": "1.2.1",
          "build": "rust", "module": "backend/src/validation/defects.py, loaded unchanged by path",
          "on": "detect_defects(expected, transcript) as given",
          "off": "the same call with every word probability removed and segments emptied",
          "note": "severity is unrounded; None fields are left out; scanNumber values are decimal strings"}
rows = lambda items: ",\n".join(json.dumps(i, ensure_ascii=False, separators=(",", ":")) for i in items)
(out / "defects.golden.json").write_text(
    '{"_source":' + json.dumps(header, ensure_ascii=False) + ',\n"cases":[\n' + rows(cases)
    + '],\n"confirm":[\n' + rows(confirms) + '],\n"scanNumber":[\n' + rows(scan) + "]}\n")
(scratch / "phonetic-inputs.json").write_text(json.dumps(phonetic_inputs))
print(len(cases), "cases,", len(confirms), "confirm,", len(scan), "scan rows,", len(set(phonetic_inputs)), "phonetic inputs")
```

### gen_metaphone.py

```python
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
gold_p, phonetic_p, out, sweep_p = (Path(a) for a in sys.argv[1:5])
import jellyfish
from jellyfish import _jellyfish as fallback

RULE = """knight knee knot gnome pneumonia write wrong aeon xylophone what whale special social
church chorus machine city cycle edge judge badger night ghost thought back pocket
phone elephant queen shell fish vision asia nation patient thin that watch catch
kitchen very water away swim box exit taxi yes beyond yellow zebra zoo summer letter ballet little accept
accident success soccer""".split()
FINAL = {
    "mb": "dumb lamb climb comb bomb thumb tomb crumb plumb numb limb womb".split(),
    "gn": "sign design resign align assign reign benign feign deign malign consign campaign".split(),
    "gh": "tough rough enough cough laugh through though dough high sigh thigh plough".split(),
}
EDGE = ["50", "o'clock", "ſtop", "x", "h", "a"]
PATTERN = re.compile(r"^[a-zſ0-9']+$")

gold = json.loads(gold_p.read_text())
headwords = sorted({k for k in gold if k == k.lower()})
taken = set(RULE) | {w for ws in FINAL.values() for w in ws} | set(EDGE)
phrases = sorted({w for w in json.loads(phonetic_p.read_text()) if PATTERN.match(w) and len(w) <= 30} - taken)
assert len(RULE) == 60, len(RULE)
chosen = RULE + [w for ws in FINAL.values() for w in ws] + phrases + EDGE
ascii_words = [w for w in headwords if re.fullmatch(r"[a-z]+", w) and w not in chosen]
fill = 200 - len(chosen)
stride = len(ascii_words) // fill
chosen += ascii_words[stride // 2::stride][:fill]
assert len(chosen) == 200 and len(set(chosen)) == 200, (len(chosen), len(set(chosen)))
assert all(PATTERN.match(w) for w in chosen)

differs = {k: sum(jellyfish.metaphone(w) != fallback.metaphone(w) for w in ws) for k, ws in FINAL.items()}
header = {"jellyfish": "1.2.1", "build": "rust", "python": "3.12", "audiobookSha": "b13d8acbedfc280b805422dfde84f1e36d0b3bac",
          "normalisation": "lowercase input; codes are jellyfish.metaphone(word) verbatim",
          "groups": {"rule": len(RULE), "finalDelta": 36, "phrase": len(phrases), "edge": len(EDGE),
                     "sampled": fill, "stride": stride, "offset": stride // 2},
          "sampling": "ascii a-z headwords of the misaki us_gold list, lowercased and sorted, every stride-th from offset",
          "finalDeltaWhereRustDiffersFromPythonFallback": differs}
cases = [{"word": w, "code": jellyfish.metaphone(w)} for w in chosen]
rows = ",\n".join(json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in cases)
(out / "metaphone.golden.json").write_text(
    '{"_source":' + json.dumps(header, ensure_ascii=False) + ',\n"allowedDifferences":[],\n"cases":[\n' + rows + "]}\n")

sweep_words = sorted(set(headwords) | set(chosen))
sweep_p.parent.mkdir(parents=True, exist_ok=True)
sweep_p.write_text(json.dumps({"_source": header, "cases": [{"word": w, "code": jellyfish.metaphone(w)} for w in sweep_words]},
                              ensure_ascii=False, separators=(",", ":")) + "\n")
print(len(phrases), "phrase words;", fill, "sampled at stride", stride, ";", len(sweep_words), "sweep words;", differs)
```

### grep_check.py

Prints each word the fixtures hold that is not a `us_gold` headword, and the number of AB book files
that contain it. Constructed words must show 0. Ordinary inflections of dictionary words and single
letters (`walked`, `C`, `Hell`) show hits, as English does.

```python
import json
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
fixtures, gold_p, books = (Path(a) for a in sys.argv[1:4])
gold = {k.lower() for k in json.loads(gold_p.read_text())}
defects = json.loads((fixtures / "defects.golden.json").read_text())
texts = []
for c in defects["cases"] + defects["confirm"]:
    for t in [c.get("transcript"), c.get("base"), c.get("confirm")]:
        if t:
            texts += [t["text"]] + [w["text"] for w in t["words"]]
    texts.append(c["expected"])
words = {w for t in texts for w in re.findall(r"[^\W\d_]+(?:'[^\W\d_]+)?", t)}
words |= {c["word"] for c in json.loads((fixtures / "metaphone.golden.json").read_text())["cases"] if c["word"].isalpha()}
unknown = sorted(w for w in words if w.lower() not in gold)
capitalised = sorted(w for w in words if w[:1].isupper() and w not in unknown)
total = 0
for w in unknown + capitalised:
    hits = subprocess.run(["grep", "-rIiwl", "--", w, str(books)], capture_output=True, text=True).stdout.count("\n")
    total += hits
    print(f"{w}\t{hits}")
print("checked", len(unknown) + len(capitalised), "words; total hit files", total)
```
