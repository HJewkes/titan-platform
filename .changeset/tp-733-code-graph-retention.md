---
"@titan-design/code-graph": patch
---

The ts-morph extractor drops extracted source files from its own Project in batches, cutting the indexer's live heap peak from about 1000 MB to about 460 MB on this repo with an identical graph.
