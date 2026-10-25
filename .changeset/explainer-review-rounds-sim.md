---
"@titan-design/explainer": minor
---

Add the pilot sim model `review-rounds` to `SIM_MODELS`, with `doctrine/sims/review-rounds.yaml`. It is a seeded Monte Carlo over `prs` PRs where round 1 passes with chance `p1` and every later round with chance `q`, emitting `mean-reviews` and `share-5plus`. `fitLaterRoundPass(p1, share5plus)` solves `q` from a 5+ share, so the doctrine lists `share-5plus` in `fittedFrom` and a claim on it is `E-SIM-CIRCULAR`; the held-out `mean-reviews` takes the code ceiling as its tolerance, declared before any held-out check.
