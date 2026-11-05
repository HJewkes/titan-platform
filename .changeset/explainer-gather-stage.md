---
"@titan-design/explainer": minor
---

Add `gather` as the workflow's first stage (TP-4078): it runs the profile's gather body (`gatherDaily`, `gatherPr` or `gatherArticle`) and its facts feed the audition and script. A `gatherPr` gather refuses a moved head and stores a `code` artifact for resolve's code citations. `explainer pr trigger` now runs a decision-brief run from gather to audition and re-reads the gates before each start; `explainer run --facts-from gatherArticle` takes `--article` and `--claims`.
