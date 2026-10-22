---
"titan-console": minor
---

Add the autoresearch run page's backlog and decisions, and widen its header. The backlog lists the newest round's queue after its picks with the pool, bold and follow-up quotas (or the planner's `[EXEMPT]` reason), the rejected adds and each idea's Thompson draw. The decisions group every decided idea by round with its verdict, rung, labelled reason, Δ in pp and σ, runs, spend and ratchet move; a superseded winner reads as requeued. The runs list gains a Round column from the new `round` and `rounds` fields on `autoresearch.runs`, and each round in `autoresearch.run` may carry the planner's `exempt` reasons.
