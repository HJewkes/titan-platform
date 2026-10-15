# speech-g2p fixtures

Golden data recorded from misaki 0.9.4, spaCy 3.8.16 with `en_core_web_sm` 3.8.0, and
num2words 0.5.14. Generated once, offline, on a machine that already had those packages in a
Python 3.12 virtualenv. Nothing in the package, its tests or CI runs Python, loads a model or
touches the network; `src/fixtures.test.ts` only reads the files below. Generators live inline
here because `scripts/structure.test.mjs` forbids `.py` files in a package.

## Files

| File | Contents | Count | Source |
|---|---|---|---|
| `corpus.json` | the input units | 418 units: 181 `rf`, 76 `het`, 161 `authored` | `rf`: the deduplicated `spoken` lines of our own explainer scripts. `het`: the 76 heteronym sentences (19 words, written for the E4 spike). `authored`: written for this package, grouped by `category` (contraction, hyphen, money, abbreviation, number, phrase, markup, quote, bracket, symbol, case, plain). |
| `misaki-golden.json` | per unit: preprocessed text, the spaCy tokens and tags misaki consumed, misaki's output tokens `{text, tag, phonemes, whitespace, rating}`, the joined phoneme string. Also `fallback` (espeak output per OOV token text, 65 entries) and `subtokens` (misaki's `subtokenize` for 1,867 token texts) | 418 units, 7,502 output tokens, 83 of them rating 2 | `misaki.en.G2P(trf=False, british=False, fallback=EspeakFallback, unk="")` over `corpus.json`, as Kokoro's `KPipeline` builds it |
| `spacy-tokens.golden.json` | spaCy's tokenizer output `{text, idx, ws}` over each unit's preprocessed text, whitespace tokens included | 418 units, 7,882 tokens | `nlp.tokenizer`; the generator asserts `Tokenizer.explain` yields the same non-space tokens |
| `num2words.golden.json` | `{form, value, words}` for cardinals, negatives, floats, years and ordinals | 170 cases | `num2words(value, to=...)`, lang `en` |
| `numbers.golden.json` | misaki's number code (`get_number`, `is_number`, `is_currency`, `append_currency`, `numeric_if_needed`) over stand-in lookups: `{word, currency, isHead, flags, result}` and the helper verdicts | 424 `get_number` cases, 34 `is_number`, 8 `is_currency`, 6 `append_currency`, 11 `numeric_if_needed` | `misaki.en.Lexicon` 0.9.4 subclassed with `<word>` lookups; generator below |
| `../../data/spacy-en-tokenizer.json` | the tokenizer's special-case rules (1,347, ORTH only), the prefix, suffix, infix and URL patterns with their flags, and 2,266 probe strings with Python's spans for each pattern | 337 KB | `nlp.tokenizer` of the same pipeline |

Total under `src/fixtures` is about 1.5 MB; the test holds it under 2 MB.

## What is not here

The corpus holds only text we own. The E4 spike also ran five audiobook chapters (79,379 of its
84,244 tokens); that text is third-party fiction, this repository is public, and it is
deliberately not committed. The opt-in corpus smoke test reads it from outside the repo.

## Quirks the golden records faithfully

- misaki sets most lexicon and fallback ratings as a plain `token.rating` attribute, not on
  `token._`, so `token._.rating` is `None` for them. `rating` in the golden is `_.rating` when
  set, else that attribute. Tokens merged from sub-tokens still carry `null`: `merge_tokens`
  reads only `_.rating`. 157 tokens with phonemes have a `null` rating for that reason.
- `rating: 2` means the espeak fallback ran. In CI the engine replays `fallback` (keyed by
  token text, which is all `EspeakFallback` reads) instead of loading espeak.
- 33 rating-2 tokens fall in the RF lines (for example `worktree`, `webhook`, `Kubernetes`,
  `triager`, `memoizes`). Without an espeak peer a shipping build gives these no phonemes.

## How they were made

Read-only against the virtualenv, offline, with the interpreter in isolated mode. espeak is
pointed at a symlink to its data directory whose path has no spaces.

```sh
SCRATCH=<an empty scratch directory outside the repo>
VENV=<virtualenv with misaki 0.9.4, spaCy 3.8.16, en_core_web_sm 3.8.0, num2words 0.5.14>
PKG=packages/speech-g2p
ln -sfn "$VENV"/lib/python3.12/site-packages/espeakng_loader/espeak-ng-data "$SCRATCH/espeak-ng-data"

# corpus.json: rf and het lines of the E4 corpus plus authored.json (a list of [category, text])
node build-corpus.mjs <e4-corpus.jsonl> authored.json "$PKG/src/fixtures/corpus.json"

HF_HUB_OFFLINE=1 ESPEAK_DATA_PATH="$SCRATCH/espeak-ng-data" \
  "$VENV/bin/python" -I gen-fixtures.py \
  "$PKG/src/fixtures/corpus.json" "$PKG/src/fixtures" "$PKG/data"
```

The generator asserts the four package versions before writing anything.

### build-corpus.mjs

```js
// Usage: node build-corpus.mjs <e4-corpus.jsonl> <authored.json> <out corpus.json>
// Keeps only the rf and het sources of the E4 corpus. The chapter source is third-party text and is dropped.
import { readFileSync, writeFileSync } from "node:fs";

const [e4Path, authoredPath, outPath] = process.argv.slice(2);
const e4 = readFileSync(e4Path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const seen = new Set();
const rf = e4
  .filter((u) => u.source === "rf")
  .map((u) => {
    const beat = u.id.slice(u.id.lastIndexOf("#") + 1);
    let id = `rf:${beat}`;
    for (let n = 2; seen.has(id); n++) id = `rf:${beat}~${n}`;
    seen.add(id);
    return { id, source: "rf", text: u.text };
  });
const het = e4
  .filter((u) => u.source === "het")
  .map((u, i) => ({ id: `het:${i}`, source: "het", word: u.word, reading: u.reading, text: u.text }));
const counters = {};
const authored = JSON.parse(readFileSync(authoredPath, "utf8")).map(([category, text]) => {
  counters[category] = (counters[category] ?? 0) + 1;
  return { id: `auth:${category}-${counters[category]}`, source: "authored", category, text };
});

const units = [...rf, ...het, ...authored];
if (new Set(units.map((u) => u.id)).size !== units.length) throw new Error("duplicate unit id");
writeFileSync(outPath, JSON.stringify({ _source: "rf + het from E4 corpus; authored in-repo", units }, null, 1) + "\n");
console.log(`rf ${rf.length}, het ${het.length}, authored ${authored.length}`);
```

### gen-fixtures.py

```python
"""TP-3027 S2 fixture generator. Run once, offline, read-only, never by tests.

  gen_fixtures.py <corpus.json> <out-dir> <data-dir>

Writes misaki-golden.json, spacy-tokens.golden.json and num2words.golden.json to <out-dir>,
and spacy-en-tokenizer.json to <data-dir>.
"""
import json
import sys
from importlib.metadata import version

import num2words as n2w_module
import spacy
from misaki import en, espeak
from num2words import num2words
from spacy.symbols import ORTH

EXPECTED = {"misaki": "0.9.4", "spacy": "3.8.16", "en_core_web_sm": "3.8.0", "num2words": "0.5.14"}
SPACY_PATTERNS = ("prefix_search", "suffix_search", "infix_finditer", "token_match", "url_match")


def check_versions():
    found = {name: version(name.replace("_", "-")) for name in EXPECTED}
    assert found == EXPECTED, found
    assert n2w_module.__name__ == "num2words"
    return found


class RecordingFallback:
    """EspeakFallback keyed only on token text, so a text -> phonemes map replays it exactly."""

    def __init__(self):
        self.inner = espeak.EspeakFallback(british=False)
        self.map = {}

    def __call__(self, token):
        ps, rating = self.inner(token)
        assert self.map.get(token.text, ps) == ps, token.text
        self.map[token.text] = ps
        return ps, rating


class RecordingNlp:
    """Wraps the spaCy pipeline so each G2P call also yields the spaCy tokens and tags it consumed."""

    def __init__(self, nlp):
        self.nlp, self.last = nlp, None

    def __call__(self, text):
        doc = self.nlp(text)
        self.last = [{"text": t.text, "idx": t.idx, "ws": t.whitespace_, "tag": t.tag_} for t in doc]
        return doc


def effective_rating(token):
    # misaki stores most lexicon and fallback ratings as a plain `token.rating` attribute, not on
    # `token._`, so `_.rating` alone is None for them. The golden records whichever is set.
    return token._.rating if token._.rating is not None else getattr(token, "rating", None)


def golden_unit(g2p, unit):
    pre, _, _ = en.G2P.preprocess(unit["text"])
    phonemes, tokens = g2p(unit["text"])
    return {
        "id": unit["id"],
        "pre": pre,
        "spacy": g2p.nlp.last,
        "tokens": [
            {"text": t.text, "tag": t.tag, "phonemes": t.phonemes, "whitespace": t.whitespace, "rating": effective_rating(t)}
            for t in tokens
        ],
        "phonemes": phonemes,
    }


def generate_misaki(units, versions):
    fallback = RecordingFallback()
    g2p = en.G2P(trf=False, british=False, fallback=fallback, unk="")
    g2p.nlp = RecordingNlp(g2p.nlp)
    rows = [golden_unit(g2p, u) for u in units]
    texts = sorted({t["text"] for r in rows for t in r["spacy"]} | {t["text"] for r in rows for t in r["tokens"]})
    return {
        "_source": {**versions, "generator": "src/fixtures/README.md", "tagger": "en_core_web_sm", "unk": ""},
        "fallback": dict(sorted(fallback.map.items())),
        "subtokens": {t: en.subtokenize(t) for t in texts},
        "units": rows,
    }, g2p


def spacy_rows(tokenizer, rows):
    out = []
    for row in rows:
        doc = tokenizer(row["pre"])
        explained = [t for kind, t in tokenizer.explain(row["pre"])]
        assert explained == [t.text for t in doc if not t.is_space], row["id"]
        out.append({
            "id": row["id"],
            "text": row["pre"],
            "tokens": [{"text": t.text, "idx": t.idx, "ws": t.whitespace_} for t in doc],
        })
    return out


def pattern_of(tokenizer, name):
    fn = getattr(tokenizer, name)
    owner = getattr(fn, "__self__", None)
    return None if owner is None else {"pattern": owner.pattern, "flags": owner.flags}


def span(m):
    return None if m is None else [m.start(), m.end()]


def probe_results(tokenizer, probe):
    return {
        "prefix_search": span(tokenizer.prefix_search(probe)),
        "suffix_search": span(tokenizer.suffix_search(probe)),
        "infix_finditer": [[m.start(), m.end()] for m in tokenizer.infix_finditer(probe)],
        "token_match": span(tokenizer.token_match(probe)) if tokenizer.token_match else None,
        "url_match": span(tokenizer.url_match(probe)) if tokenizer.url_match else None,
    }


EXTRA_PROBES = [
    "٣٤٥", "٣٫٥", "١٩٨٤", "5٪", "$٥", "(٣٤)", "état", "Œuvre", "naïve.", "…", "...", "a...b", "a--b",
    "https://example.com/a?b=c", "www.example.org.", "foo@example.com", "e.g.", "U.S.", "a.m.", "St.",
    "don't", "can't", "cannot", "won't", "y'all", "it's", "'tis", "o'clock", "3rd", "1,000", "0.5", "-4",
    "$5.99", "£3", "3¢", "5-10", "well-known", "co-op", "(a)", "[b]", "{c}", "\"quoted\"", "‘x’", "“y”",
]


def generate_spacy_data(tokenizer, rows):
    rules = {}
    for key, parts in tokenizer.rules.items():
        assert all(ORTH in p for p in parts), key
        rules[key] = [p[ORTH] for p in parts]
    probes = sorted({chunk for r in rows for chunk in r["pre"].split()} | set(EXTRA_PROBES))
    return {
        "_source": {"spacy": version("spacy"), "model": version("en-core-web-sm"), "note": "rules keep ORTH only; NORM and other attrs do not affect token boundaries"},
        "rules": rules,
        "patterns": {name: pattern_of(tokenizer, name) for name in SPACY_PATTERNS},
        "probes": [{"text": p, **probe_results(tokenizer, p)} for p in probes],
    }


CARDINALS = list(range(0, 41)) + [
    50, 60, 70, 80, 90, 99, 100, 101, 110, 111, 120, 147, 199, 200, 250, 300, 999, 1000, 1001, 1010, 1100,
    1234, 1500, 1984, 2000, 2001, 2024, 2100, 5400, 9999, 10000, 10001, 12345, 100000, 100001, 123456,
    999999, 1000000, 1000001, 1234567, 12345678, 1000000000, 2147483647,
]
YEARS = [1000, 1001, 1066, 1100, 1492, 1500, 1776, 1900, 1901, 1909, 1910, 1984, 1999, 2000, 2001, 2009, 2010, 2024, 2100, 2101]
ORDINALS = list(range(1, 32)) + [40, 42, 50, 99, 100, 101, 111, 112, 113, 121, 1000, 1001, 1984]
FLOATS = [0.0, 0.5, 0.25, 0.1, 1.5, 3.14, 3.14159, 2.71828, 10.5, 19.99, 22.6, 24.5, 100.01, 0.05, 0.001, 1234.5678]
NEGATIVES = [-1, -4, -10, -100, -0.5, -1.5]
FORMS = (("cardinal", None, CARDINALS + NEGATIVES + FLOATS), ("year", "year", YEARS), ("ordinal", "ordinal", ORDINALS))


def generate_num2words():
    cases = []
    for form, to, values in FORMS:
        for v in values:
            if to == "ordinal" and v < 0:
                continue
            out = num2words(v, to=to) if to else num2words(v)
            cases.append({"form": form, "value": v, "words": out})
    return {"_source": {"num2words": version("num2words"), "lang": "en"}, "cases": cases}


def write(path, payload):
    with open(path, "w", encoding="utf8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=None, separators=(",", ":"))
        f.write("\n")


def main(corpus_path, out_dir, data_dir):
    versions = check_versions()
    with open(corpus_path, encoding="utf8") as f:
        units = json.load(f)["units"]
    golden, g2p = generate_misaki(units, versions)
    tokenizer = g2p.nlp.nlp.tokenizer
    write(f"{out_dir}/misaki-golden.json", golden)
    write(f"{out_dir}/spacy-tokens.golden.json", {
        "_source": {"spacy": versions["spacy"], "model": versions["en_core_web_sm"], "tokenizer": "nlp.tokenizer, explain() asserted equal"},
        "units": spacy_rows(tokenizer, golden["units"]),
    })
    write(f"{out_dir}/num2words.golden.json", generate_num2words())
    write(f"{data_dir}/spacy-en-tokenizer.json", generate_spacy_data(tokenizer, golden["units"]))
    rated = [t["rating"] for u in golden["units"] for t in u["tokens"]]
    print("units", len(units), "tokens", len(rated), "rating-2", rated.count(2), "fallback", len(golden["fallback"]))


if __name__ == "__main__":
    main(*sys.argv[1:4])
```

### gen-numbers-golden.py

Written in the TP-3027 S5 slice, run the same way as `gen-fixtures.py` but needing only misaki
(no espeak, no spaCy model). 72 lines. It writes `numbers.golden.json` byte for byte.

```sh
HF_HUB_OFFLINE=1 "$VENV/bin/python" -I gen-numbers-golden.py "$PKG/src/fixtures/numbers.golden.json"
```

```python
import json
import sys
from importlib.metadata import version

from misaki.en import Lexicon

assert version("misaki") == "0.9.4", version("misaki")


class StandIn(Lexicon):
    """misaki's number code with the lexicon replaced by readable stand-ins."""

    def __init__(self):
        pass

    def lookup(self, w, t, s, c):
        return (f"<{w}>", 3 if w == "point" else 4)

    def stem_s(self, w, t, s, c):
        return (f"<{w[:-1]}>S", 2)

    def _s(self, p):
        return p + "+s"

    def _ed(self, p):
        return p + "+ed"

    def _ing(self, p):
        return p + "+ing"


WORDS = ["5", "123", "147", "1984", "2000", "007", "1,000", "10,000", "1000000", "12", "100", "305", "300",
         "3rd", "21st", "1,000th", "0.5", ".5", "3.14", "1.2.3", "10.0.0.1", "5.", "-4", "-5.5", "5.99",
         "1.00", "0.99", "0.05", "5.5", "1,234.56", "12s", "5's", "5ed", "5ing", "5'd", "100s", "1.5.0",
         "2.50", "1000", "0", "00", "10", "1,5", "7.0"]
FLAG_WORDS = {"5", "100", "1.2.3", "2000", "123", "147", "12", "305", "1,234.56"}


def get_number_cases(lex):
    cases = []
    for word in WORDS:
        for is_head in (True, False):
            for currency in (None, "$", "£", "€"):
                for flags in ("", "a", "n", "&", "an"):
                    if flags and (currency or word not in FLAG_WORDS):
                        continue
                    result = lex.get_number(word, currency, is_head, flags)
                    cases.append({"word": word, "currency": currency, "isHead": is_head, "flags": flags,
                                  "result": list(result)})
    return cases


def main(out_path):
    lex = StandIn()
    out = {"getNumber": get_number_cases(lex), "isNumber": [], "isCurrency": [], "append": [], "numeric": []}
    for w in ["5", "abc", "12th", "1,000", "5s", "5's", "5ing", "-5", "5-", "1.2.3", "th", "", "12abc",
              "1984ed", "st", "1st2", "٣"]:
        for h in (True, False):
            out["isNumber"].append({"word": w, "isHead": h, "result": Lexicon.is_number(w, h)})
    for w in ["5", "5.99", "5.999", "5.00", "1.2.3", "5.0", ".5", "5.5"]:
        out["isCurrency"].append({"word": w, "result": Lexicon.is_currency(w)})
    for c in [None, "$", "£", "€", "¥", ""]:
        out["append"].append({"ps": "x", "currency": c, "result": lex.append_currency("x", c)})
    for c in ["5", "a", "٣", "²", "½", "①", "𝟓", "⑩", "x", "٠", "१"]:
        out["numeric"].append({"char": c, "result": Lexicon.numeric_if_needed(c)})
    with open(out_path, "w", encoding="utf8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1])
```
