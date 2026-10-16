---
"@titan-design/explainer": minor
---

Add `explainer eval pace`, which runs only the pace lints on a spike script.json (`--format spike`, the default) or a strict script/v1 (`--format v1`), optionally with heard durations from `--timing`. It appends `structure.tsv` rows and an `L0-pace` run record, prints new items a minute per chapter, and exits 1 only when an error row fails. `explainer eval l0` gains `--timing` too (TP-2981).
