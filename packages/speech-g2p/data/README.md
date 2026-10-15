# Vendored data

`us_gold.json` and `us_silver.json` are copied byte for byte from the misaki 0.9.4 wheel
(`misaki/data/`). Do not edit them; `src/lexicon-data.test.ts` compares both against the
wheel's `RECORD` hashes.

| File | Bytes | sha256 |
|---|---|---|
| `us_gold.json` | 3000469 | `dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f` |
| `us_silver.json` | 3099517 | `de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475` |

Licence: Apache-2.0 as part of misaki (see `../NOTICE`). The word list's own provenance is
not stated in the wheel.
