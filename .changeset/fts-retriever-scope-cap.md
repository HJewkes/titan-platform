---
"@titan-design/retrieval": minor
---

`ftsRetriever` accepts `scope` and `cap`, which together make the five-class retrieval
shape expressible without a product writing its own SQL.

`scope` restricts a retriever to one class of owner, so it becomes one ranked list among
several rather than the whole index. RRF computes rank within a list, so a class of 92,713
spans cannot swamp a class of 1,569 — it only ever contributes its own top-N. This is the
decision that does most of the work; a pooled retriever over the same tables returns the
large class and nothing else.

`cap` is a hard ceiling on hits from one retriever, whatever the engine overfetches. The
engine's overfetch is uniform, which is the wrong shape for a class prior: some classes are
duplicate content of others and should contribute a handful of candidates at most. It
composes with `fusion.weights` rather than replacing it — the weight sets how much a hit
counts, the cap sets how many there are.

Both default to absent, so existing retrievers are unchanged.
