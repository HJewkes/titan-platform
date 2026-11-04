---
"@titan-design/explainer": minor
---

Add `--samples n` to `explainer stage`, plus `explainer ab` and `explainer aa-floor`. They measure a model stage
(script, rewrite) over n cached samples per case through `summarizeMeasure`, write an A/A noise floor σ per target row
to the stage unit's notes, and judge a variant's difference within 2σ of that floor as noise, not a win.
`summarizeMeasure` now accepts an input with no before.
