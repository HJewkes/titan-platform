---
"@titan-design/session-graph": minor
---

Add an optional `TaskResolver` seam to the refresh pass. A caller may pass `resolveTasks`
to fill task `title`, `initiative` and present `status` from its own store; with no
resolver the graph is unchanged and still rebuilds from transcripts alone. The resolver is
called once per pass with every task id, its stated fields take precedence over
transcript-derived ones while omitted fields keep them, and a resolver that throws costs
that pass its enrichment only, reported as `summary.tasks.failed` with the `error` message.
