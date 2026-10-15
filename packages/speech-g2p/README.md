# @titan-design/speech-g2p

Tier 1 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Status: scaffold. This release carries the token types and the vendored misaki 0.9.4 US
lexicon (`data/`, see `NOTICE`). The G2P engine, tokenizer and tagger land in later releases.
