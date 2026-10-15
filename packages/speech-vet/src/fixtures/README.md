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
