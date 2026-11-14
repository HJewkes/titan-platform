---
"@titan-design/active-work": patch
---

`miner cost` and `miner outcomes` fold every initiative withheld from agents into one `owner-only` bucket for a non-owner caller, with rates recomputed over the folded sums, and collapse an `other:<dir>` key to `other` unless the dir is a shown initiative. `active-work new` refuses the slugs `unknown`, `other` and `owner-only`, which the miner uses as report keys (TP-5556, TP-5748, TP-5749, TP-5750).
