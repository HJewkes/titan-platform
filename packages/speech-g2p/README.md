# @titan-design/speech-g2p

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

English text to misaki 0.9.4 phoneme tokens in pure TypeScript: a port of misaki's US
lexicon G2P over a port of spaCy's English tokenizer, tagged by compromise. No Python,
no model, no network.

```ts
import { misakiEnglish, ttsTokens } from "@titan-design/speech-g2p";

const g2p = misakiEnglish();
const { phonemes, tokens } = g2p.phonemize("It cannot read [memoizes](/mˈɛməwˌIzᵻz/) yet.");
const input = { tokens: ttsTokens(tokens), alphabet: "misaki" as const }; // speech-tts TtsInput
g2p.version; // cache key: lexicon, tokenizer data and compromise release
```

Words misaki would send to espeak (rating 2) come back with `phonemes: null`, or with
partial phonemes for a compound such as `file_name.txt`. Pass `fallback` to read them.

The vendored data (`data/`) is misaki's and spaCy's; see `NOTICE`.
