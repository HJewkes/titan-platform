---
"@titan-design/code-graph": patch
---

The indexer atomicity tests allow 30 seconds, matching the other indexing tests. Each test runs two
full indexes, which went past the 5 second default on a loaded CI runner.
