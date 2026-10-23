---
"@titan-design/explainer": minor
---

Give pr-overview a spine source (TP-4097): a profile's optional `spine: { from: audition-pick }` makes the audition also write `spine`, its pick as a `spine/v1` story spine (`pickSpine`), so a run through the script needs no `--spine`. `explainer pr trigger` now runs a decision-brief run from gather through the script.
