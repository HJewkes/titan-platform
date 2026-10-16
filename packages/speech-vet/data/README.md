# Vendored data

`panphon/ipa_all.csv` and `panphon/LICENSE` are copied byte for byte from panphon 0.22.2
(MIT, Carnegie Mellon University). Do not edit them; `src/feature-table.test.ts` checks the
CSV against the bytes and sha256 below. The CSV is the phone feature table behind the
feature distance; `src/feature-table.ts` parses it lazily.

- Source: `https://raw.githubusercontent.com/dmort27/panphon/80a9cc9fafa237b9913388e79b5bce0425250e88/panphon/data/ipa_all.csv`
- Licence source: `https://raw.githubusercontent.com/dmort27/panphon/80a9cc9fafa237b9913388e79b5bce0425250e88/LICENSE.txt`
- Release: `0.22.2` (PyPI, 2025-06-12)
- Commit: `80a9cc9fafa237b9913388e79b5bce0425250e88`
- Bytes: `356894`
- sha256: `0ec0052edf4e58c8c23eda10c0195687eb167ce9bd206cf9a85b9cce8b181f0a`
- Header: `ipa,syl,son,cons,cont,delrel,lat,nas,strid,voi,sg,cg,ant,cor,distr,lab,hi,lo,back,round,velaric,tense,long,hitone,hireg`
- Non-tone features: `syl son cons cont delrel lat nas strid voi sg cg ant cor distr lab hi lo back round velaric tense long`
- FEATURE_COUNT: `22`
- Alias map: `g=ɡ tʃ=t͡ʃ dʒ=d͡ʒ ᵻ=ɨ ɚ=ə˞`

## Provenance

The repository has no `0.22.2` or `v0.22.2` tag (its newest tags stop at `0.19.1`). The
release is therefore pinned by commit: `80a9cc9f…` is the commit "Incremented version to
0.22.2" (2025-06-12). At that commit `panphon/data/ipa_all.csv` is git blob
`6911103bb53223910949610a81f697849e0c7c64`, which is also the blob inside the 0.22.2 sdist
(`panphon-0.22.2.tar.gz` from files.pythonhosted.org). The sdist's `ipa_all.csv` and
`LICENSE.txt` are byte-identical to the two files fetched from raw.githubusercontent.com at
that commit (`cmp`).

The file is under 1 MB, so it is vendored whole, not as a subset.

## Notes on the table

- The two tone columns `hitone` and `hireg` are ignored. `FEATURE_COUNT` is the count of the
  other 22 columns, and loading fails if the header's non-tone columns differ from that list.
- The file uses CRLF line ends (upstream's own bytes); the parser accepts LF or CRLF.
- Values `+`, `-` and `0` (not applicable) become 1, -1 and 0.
- panphon has no row for the diphthongs eɪ aɪ oʊ aʊ ɔɪ, nor for the plain ASCII `g`, `ᵻ` or
  `ɚ`. It has `t͡ʃ` and `d͡ʒ` (with a tie bar), `ɨ`, `ə˞` and `ɡ` (U+0261).
- Aliases, resolved against the real CSV, applied after NFC normalisation:
  `g` (U+0067) → `ɡ` (U+0261); `tʃ` → `t͡ʃ`; `dʒ` → `d͡ʒ`; `ᵻ` → `ɨ` (the nearest
  unrounded high central vowel); `ɚ` → `ə˞` (panphon's rhotacised schwa). The inventory test
  enforces that each alias resolves to its panphon row.
- Diphthongs stay unresolved here: `featureVector` returns `undefined` and the distance
  prices them as two-component segments.
