# speech-stt fixtures

`sequence-matcher.golden.json` holds CPython `difflib.SequenceMatcher` output (matching
blocks, opcodes and ratio) for synthetic pairs. It was generated once, from the package
directory, with the command below. It is a one-off fixture generator, not a build step:
nothing in the package or its tests runs Python.

```sh
python3 -I -c '
import difflib, json, random, sys
rng = random.Random(3025)
W = str.split
pairs = [
    ("abcd", "bcde"),
    ("qabxcd", "abycdf"),
    ("", ""),
    ("abc", ""),
    ("", "abc"),
    ("aaaa", "aa"),
    ("abab", "baba"),
    ("abcabba", "cbabac"),
    ("private thread currentthread", "private volatile thread currentthread"),
    (W("the quick brown fox jumps over the lazy dog"), W("the quick brown dog jumps over the lazy fox")),
    (W("hello there general kenobi"), W("hello there general kenobi")),
    (W("one two three four five"), W("one three five seven")),
    (W("a b c d e f g"), W("g f e d c b a")),
    (W("she sells sea shells by the sea shore"), W("he sells see shells by a sea shore")),
    (W("the cat sat on the mat"), W("the the cat cat sat sat")),
]
for n in range(20):
    alpha = "abcde"[: 2 + n % 4]
    pairs.append(("".join(rng.choice(alpha) for _ in range(rng.randint(0, 40))),
                  "".join(rng.choice(alpha) for _ in range(rng.randint(0, 40)))))
vocab = W("the a of and to in is it that was") + ["w%d" % i for i in range(100)]
def edit(seq, rate):
    out = []
    for x in seq:
        r = rng.random()
        if r < rate: continue
        if r < 2 * rate: out.append(rng.choice(vocab)); continue
        out.append(x)
        if r > 1 - rate: out.append(rng.choice(vocab))
    return out
for n in range(5):
    base = [rng.choice(vocab) for _ in range(30)]
    pairs.append((base, edit(base, 0.1)))
def popular(n):
    return [rng.choice(vocab[:10]) if rng.random() < 0.4 else rng.choice(vocab[10:]) for _ in range(n)]
big_words = popular(300)
big_text = " ".join(popular(60))
big = [("words-300", big_words, edit(big_words, 0.08)), ("chars-300", big_text, "".join(edit(list(big_text), 0.05)))]
def record(name, a, b, autojunk):
    m = difflib.SequenceMatcher(None, a, b, autojunk=autojunk)
    return {"name": name, "autojunk": autojunk, "a": list(a), "b": list(b),
            "matchingBlocks": [list(x) for x in m.get_matching_blocks()],
            "opcodes": [list(x) for x in m.get_opcodes()], "ratio": m.ratio()}
cases = [record("pair-%02d" % i, a, b, True) for i, (a, b) in enumerate(pairs)]
for name, a, b in big:
    assert len(b) >= 200
    on, off = record(name + "-autojunk", a, b, True), record(name + "-no-autojunk", a, b, False)
    assert on["opcodes"] != off["opcodes"], name
    cases += [on, off]
out = {"python": sys.version.split()[0], "cases": cases}
print("{\"python\": %s, \"cases\": [\n%s\n]}" % (json.dumps(out["python"]), ",\n".join(json.dumps(c) for c in cases)))
' > src/fixtures/sequence-matcher.golden.json
```
