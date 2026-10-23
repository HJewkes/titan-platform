---
"@titan-design/explainer": minor
---

The `audition` stage now samples, scores and picks (TP-4010, PP-8). After the material map, one verbalized-sampling call returns k spines (the profile's `audition.k`) with stated likelihoods, under different structures where enough fit. Each spine is scored by code (fit, coverage, tension, range, freshness) and by the reported-only cold-viewer rubric, and the agent picks the highest code total with no owner gate. `audition.json` keeps every candidate, its scores, the pick, the margin and the runner-up, and the stage notes name the runner-up. With 0 candidates the profile's fixed order leads the pool and the reason is recorded; an undecided structure only tops the pool up to k. The stage stops at the storyboard, and its key now covers the sampling model and the judge.
