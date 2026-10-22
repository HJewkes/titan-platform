---
"@titan-design/explainer": minor
---

Add `explainer rewrite measure`, a multi-sample measure of the rewrite pass. It rewrites each input n times (default 3), scores every output with L0, and reports each target row's mean, sample sd and n per input. Each cell is marked in band, closer than before, and decided or still within noise; each row gets its verdict under the revised done-when (every input closer, and the mean over inputs in band or within one pooled sample sd). It records the spend per run and in total, and `--max-usd` stops before a run that would pass the cap. Runs already written in `--out-dir` are reused. `summarizeMeasure` and `measureTable` are exported, and so is `MAX_CROWDED_BEAT_SHARE`.
