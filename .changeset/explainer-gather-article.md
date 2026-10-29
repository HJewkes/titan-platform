---
"@titan-design/explainer": minor
---

Add `gatherArticle`, the paper-summary profile's gather stage: `facts.jsonl` from an article's text, with claims and numbers kept only when their quotes are verbatim and short, and every captioned figure's table data extracted for re-plotting. Add `paperPublishEligibility`, which runs the profile's `figures-replotted-from-data` and `quotes-short` checks over a video's `beats.json`. Passing makes a video eligible to publish; publishing still needs an explicit owner ask per video.
