# session-graph: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You query a growing corpus of Claude Code and Codex sessions repeatedly and want it folded into an incrementally maintained SQLite graph. For explicit harness-neutral normalized ingestion, supply an observation source port to indexSource and its text port to readIndexedText; unavailable observation capabilities return typed unavailable before graph/file access. The legacy indexCodexSource entry remains compatible.
