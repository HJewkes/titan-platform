---
"@titan-design/factory": minor
---

Add the autoresearch workflow skeleton (S1): a central planner's queue ops checked against quotas and the bounds pre-check, Thompson sampling over lineages with a seeded RNG, a pipelined per-idea ladder (L0 static, L1 micro, L2 one run, L3 repeats with confirm runs) fanned out with `mapItems`, the keep rule with a pooled within-pair σ band, dead-end and bug registries, a planner digest that never carries validator rows, and a fast-forward-only ratchet push. Ports are fakes in this slice; no CLI or production wiring yet.
