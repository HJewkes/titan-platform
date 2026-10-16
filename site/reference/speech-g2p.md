# speech-g2p

**Tier 1 · engines.** No titan dependencies; one npm dependency, `compromise` 14.18.0
(pinned exactly). No model downloads and no network.

```sh
npm install @titan-design/speech-g2p
```

## The problem it solves

Kokoro reads misaki phonemes, and misaki is Python: its G2P runs spaCy's tokenizer and
tagger, then a lexicon with tag-keyed readings, stress rules and number reading. Without
Python, a TypeScript product could not produce Kokoro's input, honour `[word](/phonemes/)`
overrides, or dump the per-token readings that pronunciation checks need.

This package ports misaki 0.9.4's US English G2P and spaCy 3.8's English tokenizer to
TypeScript, and tags with compromise through a Penn Treebank adapter. `misakiEnglish()` is
the one primitive: text in, misaki tokens and the joined phoneme string out.

## When to reach for it

You need phonemes for English text: Kokoro input through speech-tts (`ttsTokens`), a
heteronym check through speech-vet (a `G2pToken[]` is a `PhonemeToken[]`), or IPA for a
caption or a listener (`misakiToIpa`). Synthesis itself is `speech-tts`; deciding whether a
reading is the declared one is `speech-vet`.

## Example

Verified against the 0.0.0 workspace build.

```ts
import { misakiEnglish, misakiToIpa, ttsTokens } from "@titan-design/speech-g2p";

const g2p = misakiEnglish();
const { phonemes, tokens } = g2p.phonemize("We live here.");
phonemes;                    // "wˌi lˈɪv hˈɪɹ."
tokens[1];                   // { text: "live", tag: "VBP", phonemes: "lˈɪv", whitespace: " ", rating: 4 }
misakiToIpa(phonemes);       // IPA, stress kept
ttsTokens(tokens);           // speech-tts TtsToken[]: null phonemes become "" (Kokoro's unk)
g2p.version;                 // "misaki-0.9.4+<16 hex>", a cache key
```

## What it deliberately does not do

- No espeak. A word outside misaki's lexicon is returned unread unless the caller passes
  `fallback`; misaki itself would ask espeak (GPL) for it.
- No British English. Only the US lexicon is vendored.
- No chunking at Kokoro's 510-phoneme limit and no word timings; those belong to the Kokoro
  provider.
- `spacyTokenizer` and `compromiseTagger` are not exported. `misakiEnglish` uses them by
  default; pass your own `tokenizer` or `tagger` to replace them.

## Gotchas

- Without a `fallback`, out-of-lexicon words read as `phonemes: null`, and a compound such as
  `file_name.txt` or `usr/local/bin` keeps only its known parts. Kokoro skips the missing
  sounds silently, so warn on `phonemes === null` before synthesis. On a 2,839-unit test
  corpus of mostly fiction, this costs about 2 % of word tokens.
- Tagging is compromise's, not spaCy's. On the CI golden, 99.3 % of non-heteronym word tokens
  match misaki with spaCy exactly, stress included. Most of the remainder is stress on
  `that` and `in`. Heteronyms (`read`, `use`, `live`, ...) are where the tagger matters most:
  declare them with speech-vet.
- `compromise` is pinned exactly because its tags move between releases; a bump changes
  `version` and needs the parity tests rerun.
- `rating` is mostly `null`: misaki records it on only some paths. Do not rely on it.
- Construction reads about 6 MB of lexicon JSON from `data/`; build one `misakiEnglish()` and
  reuse it.

## Where it came from

New (TP-3027). It replaces the Python misaki process in the speech pipeline. It reaches
99.42 % stress-strict parity with misaki and spaCy on the E4 spike's 2,839-unit corpus, and
the tokenizer matches spaCy on every unit. The port follows misaki 0.9.4 (Apache-2.0) and spaCy
3.8.16 (MIT); see the package `NOTICE`.
