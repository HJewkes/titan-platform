---
"@titan-design/store-sqlite": minor
---

`SpanFtsTables.search` accepts an optional `SpanScope`, so one span table holding several
entity classes can be queried one class at a time.

Ranking one pooled query over a mixed span table returns whichever class is largest and
nothing else. Measured on active-work's graph: 92,713 transcript spans against 1,569 note
spans, 59 to 1. A separate ranked list per class fixes it, and that needs a way to ask for
one class.

`ownerPrefix` and `fields` are both needed, not either. active-work keys both a mined
transcript and a workspace session record under `session:`, separable only by field —
`body` is the record, `prompt` and the `tool_*` fields are the transcript. A prefix-only
filter would put 92,713 transcript spans into the records' list and look like it was
working.

`ownerPrefix` compiles to a half-open range rather than `LIKE` or `GLOB`, so the existing
owner index applies and `note:` cannot bleed into `notebook:`. One prepared statement is
cached per scope shape. Measured over 102,768 spans, a scoped query costs what an unscoped
one costs: 3-10ms, worst case on the rarest class, because SQLite walks the match list to
find its few hits.

`limit` applies after the scope, so a scoped search returns its own top-N rather than
whatever survives the filter out of a global top-N. Omitting `scope` is unchanged.
