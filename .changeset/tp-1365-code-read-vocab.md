---
"@titan-design/code-read": minor
"codewatch": patch
---

Export the reason vocabularies as const tuples: `EXCERPT_MISSING` (with `ExcerptMissing`, which now types `SourceRead.unavailable`) and `MISSING_REASONS` (which types `Missing`). Export `FindingSort`, the `findings.list` sort enum, and `SYNTHESIZED_KINDS` with `isStoredKind`, so a consumer can tell which nodes `node.neighbors` accepts. codewatch derives its sort keys and its stored-kind check from these instead of restating them.
